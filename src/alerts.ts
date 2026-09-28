// Ops alerts: store extensive logs + auto-explanation, notify Slack on retries/failures.
import { authPool } from './db.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_ALERTS_WEBHOOK_URL || '';
const SLACK_ENABLED = (process.env.SLACK_ALERTS_ENABLED ?? 'true').toLowerCase() !== 'false';
const ALERT_MIN_ATTEMPTS = Math.max(1, Number(process.env.ALERT_MIN_ATTEMPTS || 2));

export type AlertKind =
  | 'analysis_retry'
  | 'analysis_failed'
  | 'identity_ocr_failed'
  | 'file_access_error'
  | 'payment_eval_retry'
  | 'payment_eval_failed'
  | 'gst_api_failed'
  | 'gst_details_missing'
  | 'mca_api_failed'
  | 'mca_details_missing'
  | 'upsida_push_failed';

export type AlertSeverity = 'warning' | 'critical' | 'info';

export type AlertLogEntry = {
  attempt?: number;
  at?: string;
  ok?: boolean;
  error?: string | null;
  durationMs?: number;
  fieldCount?: number;
  hadSignature?: boolean;
  source?: string;
  httpStatus?: number | null;
  [key: string]: unknown;
};

export type EmitAlertInput = {
  kind: AlertKind;
  severity?: AlertSeverity;
  applicationId?: string | null;
  analysisId?: string | null;
  userId?: string | null;
  serviceNo?: string | null;
  attemptCount: number;
  passed?: boolean | null;
  logs?: AlertLogEntry[];
  context?: Record<string, unknown>;
};

export type EmitAlertResult = {
  id?: string;
  slackSent: boolean;
  skipped?: boolean;
  reason?: string;
};

function redactText(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const u = new URL(url);
        return `${u.origin}${u.pathname.slice(0, 40)}${u.pathname.length > 40 ? '…' : ''}[redacted]`;
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/hooks\.slack\.com\/services\/[^\s]+/gi, 'hooks.slack.com/services/[redacted]');
}

function redactLogs(logs: AlertLogEntry[]): AlertLogEntry[] {
  return logs.map((e) => {
    const copy: AlertLogEntry = { ...e };
    if (typeof copy.error === 'string') copy.error = redactText(copy.error);
    return copy;
  });
}

export type IssueDesc = {
  title: string;
  issue: string;
  errorCode: string;
  check: string[];
};

function lastHttpStatus(logs: AlertLogEntry[]): number | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const s = logs[i]?.httpStatus;
    if (typeof s === 'number') return s;
  }
  return null;
}

/** One plain-English issue + error code + what to check. */
export function describeIssue(input: {
  kind: AlertKind;
  attemptCount: number;
  passed?: boolean | null;
  logs: AlertLogEntry[];
  context?: Record<string, unknown>;
}): IssueDesc {
  const ctx = input.context || {};
  const errors = input.logs
    .map((l) => (typeof l.error === 'string' ? l.error : ''))
    .filter(Boolean)
    .map(redactText);
  const joined = errors.join(' | ').toLowerCase();
  const detail = String(ctx.hardFailDetail || ctx.detail || ctx.error_msg || errors[errors.length - 1] || '');
  const aadhaarOk = ctx.aadhaarValid === true;
  const panOk = ctx.panValid === true;
  const identityNote =
    typeof ctx.identitySummary === 'string' && ctx.identitySummary.trim()
      ? ctx.identitySummary.trim()
      : '';
  const userId = String(ctx.userId || '').trim();
  const userBit = userId ? ` User ID \`${userId}\`.` : '';
  const http = lastHttpStatus(input.logs);
  const httpNote = http != null ? ` (HTTP ${http})` : '';

  if (input.kind === 'file_access_error' || ctx.hardFailCode === 'FILE_ACCESS_ERROR') {
    return {
      title: 'Could not download the DPR',
      errorCode: 'FILE_ACCESS_ERROR',
      issue:
        'We could not download the Detailed Project Report from the URL the partner sent, so analysis never started.' +
        (detail ? ` ${redactText(detail).slice(0, 180)}` : ''),
      check: [
        'Open the document URL from the partner payload in a browser / curl — is it 200 and a PDF?',
        'If it is a pre-signed MinIO/S3/Nivesh Mitra link, check it has not expired.',
        'Confirm the host is reachable from this server (TLS/firewall).',
        'If they sent sha256, confirm it matches the file (`shasum -a 256`).',
      ],
    };
  }

  if (/402|subscription/.test(joined) || /402|subscription/.test(detail.toLowerCase())) {
    return {
      title: 'OCR billing is down',
      errorCode: 'OCR_BILLING_402',
      issue:
        'We could not read the uploaded PDFs because the Mistral OCR account is out of credit or the subscription is inactive. No applicant data was extracted.',
      check: [
        'Open https://admin.mistral.ai/subscription and confirm credit / plan is active.',
        'Confirm the key on the box: `/home/ubuntu/main-api-bs/bhoomi-suvidha-upsida-ai-service/.env` (`MISTRAL_API_KEY`) is the key you topped up.',
        'No restart is needed after a top-up — retry `/v1/analysis`.',
        'If you rotated the key, update that .env and restart uvicorn on port 8422.',
      ],
    };
  }

  if (/sha256|checksum/.test(joined)) {
    return {
      title: 'Document checksum did not match',
      errorCode: 'DOC_CHECKSUM_MISMATCH',
      issue:
        'The file we downloaded does not match the SHA-256 the partner sent. The file may have changed, or the hash is wrong. Analysis stopped.',
      check: [
        'Re-download the URL and run `shasum -a 256` — compare to the payload `sha256`.',
        'Ask the partner to re-upload the file and send a fresh checksum.',
      ],
    };
  }

  if (input.kind === 'identity_ocr_failed') {
    const missing: string[] = [];
    if (!aadhaarOk) missing.push('Aadhaar');
    if (!panOk) missing.push('PAN');
    const which = missing.length ? missing.join(' and ') : 'Aadhaar / PAN';
    const code =
      missing.length === 1 && missing[0] === 'Aadhaar'
        ? 'OCR_AADHAAR_FAILED'
        : missing.length === 1 && missing[0] === 'PAN'
          ? 'OCR_PAN_FAILED'
          : 'OCR_IDENTITY_FAILED';
    return {
      title: `${which} could not be read`,
      errorCode: code,
      issue:
        `The application analysis finished, but we could not validate Aadhaar or PAN (one of the two is enough). ${which} failed OCR. ` +
        'Document verification will show as failed. The DPR itself may still have been processed. ' +
        (identityNote || 'Usually this is a blurry scan, the wrong file, or a failed OCR call.'),
      check: [
        'Open the Aadhaar/PAN PDF from MinIO / the partner URL — is it actually an ID, not a blank or DPR page?',
        'If the scan is unreadable, ask the applicant to re-upload a clearer file.',
        `POST the same file to http://127.0.0.1:8422/extract/aadhaar or /extract/pan and read the error.`,
        'If Mistral/AI service is unhealthy: `curl http://127.0.0.1:8422/health` and `tail /tmp/ai-service-8422.log`.',
      ],
    };
  }

  if (input.kind === 'analysis_failed') {
    if (/empty|unusable|no core fields/.test(joined)) {
      return {
        title: 'DPR OCR returned nothing useful',
        errorCode: 'OCR_DPR_EMPTY',
        issue:
          'The DPR file downloaded, but OCR could not pull out project fields (company, activity, cost, land, employment). The PDF may be a photo of a scan, the wrong document, or too low quality. Analysis did not complete.',
        check: [
          'Open the DPR PDF — is it a real project report, not a 1-page stub or image-only scan?',
          'Try `POST http://127.0.0.1:8422/extract/dpr` with the same file.',
          'If the PDF is image-only, Mistral should still OCR it; if fields are blank, the document may not be a DPR.',
        ],
      };
    }
    return {
      title: 'DPR OCR failed',
      errorCode: 'OCR_DPR_FAILED',
      issue:
        `The DPR was downloaded, but the OCR service failed after retries${httpNote}, so we have no extracted project details. The applicant will see a failed analysis.` +
        (detail ? ` ${redactText(detail).slice(0, 180)}` : ''),
      check: [
        '`curl -s http://127.0.0.1:8422/health` — AI service must be ok.',
        '`tail -80 /tmp/ai-service-8422.log` — look for 402, timeout, or traceback.',
        'Confirm uvicorn is the `main-api-bs/bhoomi-suvidha-upsida-ai-service` process on 8422 (that is what partner APIs call).',
        'Retry `/v1/analysis` after the service is healthy.',
      ],
    };
  }

  if (input.kind === 'analysis_retry') {
    return {
      title: 'OCR failed once, then recovered',
      errorCode: 'OCR_RETRY_RECOVERED',
      issue:
        'Reading the PDFs failed on the first try (timeout or service error) but succeeded on retry. The analysis completed. Heads-up that OCR was flaky — no action needed unless it keeps happening.',
      check: [
        'If this repeats, check 8422 logs and Mistral latency (`tail /tmp/ai-service-8422.log`).',
        'Watch for 429/5xx from Mistral — may need backoff or more quota.',
        'No applicant action unless the channel is filling up with these.',
      ],
    };
  }

  if (input.kind === 'mca_details_missing') {
    return {
      title: userId ? `MCA details not present — user ${userId}` : 'MCA details not present',
      errorCode: 'MCA_DETAILS_MISSING',
      issue:
        `User ${userId || 'unknown'} has no CIN/LLPIN, so live MCA lookup was skipped.${userBit} Marks were still scored and sent to UPSIDA.`,
      check: [
        'Check `nm_response.applicant.cin` — empty means the partner did not send a CIN.',
        'Ask Nivesh Mitra to include `applicant.cin` on the next analysis if MCA is required.',
      ],
    };
  }

  if (input.kind === 'mca_api_failed') {
    return {
      title: userId ? `MCA API failed — user ${userId}` : 'MCA API failed',
      errorCode: 'MCA_API_FAILED',
      issue:
        `User ${userId || 'unknown'}: we have a CIN, but the live MCA lookup failed.${userBit} Marks were still scored and sent to UPSIDA without live MCA data.`,
      check: [
        '`POST http://127.0.0.1:8422/verify/mca` with the same CIN.',
        'Check `ATTESTR_API_TOKEN` on the 8422 AI service `.env` (it is optional and may be unset).',
        '`tail /tmp/ai-service-8422.log` for Attestr errors.',
      ],
    };
  }

  if (input.kind === 'gst_details_missing') {
    return {
      title: userId ? `GST details not present — user ${userId}` : 'GST details not present',
      errorCode: 'GST_DETAILS_MISSING',
      issue:
        `User ${userId || 'unknown'} has no GSTIN. We scored marks from the DPR only, skipped GST vs DPR compare, and still sent the assessment to UPSIDA.`,
      check: [
        'Open the `/v1/analysis` payload / `nm_response.applicant` — is `gstin` empty or missing?',
        'Ask the partner (Nivesh Mitra) to send `applicant.gstin` on the next analysis.',
        'Marks still ran; only GST cross-check was skipped. No need to restart services.',
      ],
    };
  }

  if (
    input.kind === 'gst_api_failed' ||
    (input.kind === 'payment_eval_failed' && /verify\/gstin|gst/.test(joined) && !/\/evaluate/.test(joined))
  ) {
    return {
      title: userId ? `GST API failed — user ${userId}` : 'GST API failed',
      errorCode: 'GST_API_FAILED',
      issue:
        `User ${userId || 'unknown'}: we have a GSTIN, but the live GST lookup failed after retries.${userBit} DPR vs GST compare was skipped. Marks were still sent to UPSIDA.` +
        (detail ? ` ${redactText(detail).slice(0, 180)}` : ''),
      check: [
        'Call `POST http://127.0.0.1:8422/verify/gstin` with the same GSTIN — does AuthBridge answer?',
        'Check `AUTHBRIDGE_USERNAME` (and related secrets) on `/home/ubuntu/main-api-bs/bhoomi-suvidha-upsida-ai-service/.env`.',
        'Confirm the GSTIN format (15 chars). A bad number still usually returns structured data, not a 502.',
        '`tail /tmp/ai-service-8422.log` for TruthScreen / AuthBridge errors.',
      ],
    };
  }

  if (input.kind === 'payment_eval_failed') {
    return {
      title: 'Post-payment evaluation failed',
      errorCode: 'PAYMENT_EVAL_FAILED',
      issue:
        'GST lookup succeeded (or was not the failing step), but comparing the DPR to GST via `/evaluate` failed after retries. Marks were still sent to UPSIDA without the AI GST verdict.' +
        (detail ? ` ${redactText(detail).slice(0, 180)}` : ''),
      check: [
        '`curl -s http://127.0.0.1:8422/health`.',
        '`POST /evaluate` on 8422 with the stored DPR extraction + GST JSON.',
        'Check Anthropic key / quota if evaluate times out.',
        'Row is in `evaluation_check` with `error_msg`.',
      ],
    };
  }

  if (input.kind === 'payment_eval_retry') {
    return {
      title: 'Evaluation succeeded after a retry',
      errorCode: 'PAYMENT_EVAL_RETRY',
      issue:
        'The post-payment AI evaluation failed at first, then succeeded. The assessment was produced. Heads-up only.',
      check: [
        'If this is frequent, check `/evaluate` latency and Anthropic / GST API health.',
      ],
    };
  }

  if (input.kind === 'upsida_push_failed') {
    return {
      title: 'Could not send the assessment to UPSIDA',
      errorCode: 'UPSIDA_PUSH_FAILED',
      issue:
        'We finished scoring the application, but pushing SaveAssessment to UPSIDA failed. The evaluation is saved on our side; UPSIDA does not have it yet.' +
        (detail ? ` ${redactText(detail).slice(0, 180)}` : ''),
      check: [
        'Confirm `service_no` on the payment / evaluation_check row is the real UPSIDA ServiceNo.',
        'Check `UPSIDA_API_BASE_URL` and `UPSIDA_API_TOKEN` in `/home/ubuntu/apis/.env`.',
        'If Slack/logs show HTTP 404, the ServiceNo path is wrong (common on staging).',
        'Re-run the payment evaluation push once ServiceNo / token is fixed.',
      ],
    };
  }

  return {
    title: 'Analysis pipeline issue',
    errorCode: 'ANALYSIS_UNKNOWN',
    issue:
      'Something went wrong in the analysis pipeline. See the attempt log below.' +
      (detail ? ` Last error: ${redactText(detail).slice(0, 200)}` : ''),
    check: [
      'Read the attempt log in this Slack message and the `alerts` row in Postgres.',
      '`curl -s http://127.0.0.1:8422/health` and `pm2 logs bhoomi-partner-apis --lines 50`.',
    ],
  };
}

/** Rule-based auto-explanation from attempt logs + context. */
export function autoExplain(input: {
  kind: AlertKind;
  attemptCount: number;
  passed?: boolean | null;
  logs: AlertLogEntry[];
  context?: Record<string, unknown>;
}): { summary: string; explanation: string; title: string; issue: string; errorCode: string; check: string[] } {
  const logs = input.logs;
  const failed = logs.filter((l) => l.ok === false);
  const { title, issue, errorCode, check } = describeIssue(input);

  const outcome =
    input.passed === true
      ? 'eventually SUCCEEDED after retries'
      : input.passed === false
        ? 'FAILED after retries'
        : 'completed with multi-attempt activity';

  const summary = issue.slice(0, 350);

  const attemptLines = logs
    .slice(-12)
    .map((l) => {
      const n = l.attempt ?? '?';
      const ok = l.ok === true ? 'OK' : l.ok === false ? 'FAIL' : '?';
      const src = l.source || 'step';
      const err = typeof l.error === 'string' && l.error ? redactText(l.error).slice(0, 180) : '';
      const ms = typeof l.durationMs === 'number' ? `${l.durationMs}ms` : '';
      const http = l.httpStatus != null ? `http=${l.httpStatus}` : '';
      return `• #${n} [${ok}] ${src} ${ms} ${http}${err ? ` — ${err}` : ''}`.trim();
    })
    .join('\n');

  const explanation = [
    `Error code: ${errorCode}`,
    issue,
    check.length ? `What to check:\n${check.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}` : '',
    `Pipeline ${outcome} after ${input.attemptCount} attempt(s). Failed steps: ${failed.length}/${logs.length || 0}.`,
    attemptLines ? `Attempt log (recent):\n${attemptLines}` : 'No per-attempt log entries.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { summary, explanation, title, issue, errorCode, check };
}

function shouldAlert(attemptCount: number, kind: AlertKind, passed?: boolean | null): boolean {
  if (kind === 'upsida_push_failed' || kind.endsWith('_failed') || kind === 'file_access_error') return true;
  if (
    kind === 'identity_ocr_failed' ||
    kind === 'gst_details_missing' ||
    kind === 'gst_api_failed' ||
    kind === 'mca_details_missing' ||
    kind === 'mca_api_failed'
  )
    return true;
  if (attemptCount >= ALERT_MIN_ATTEMPTS) return true;
  if (passed === false && attemptCount >= 1) return true;
  return false;
}

function buildSlackBlocks(opts: {
  id: string;
  kind: string;
  severity: string;
  title: string;
  issue: string;
  errorCode: string;
  check: string[];
  summary: string;
  explanation: string;
  applicationId?: string | null;
  analysisId?: string | null;
  userId?: string | null;
  serviceNo?: string | null;
  attemptCount: number;
  passed?: boolean | null;
  logs: AlertLogEntry[];
}): Record<string, unknown> {
  const emoji = opts.severity === 'critical' ? '🚨' : opts.severity === 'warning' ? '⚠️' : 'ℹ️';
  const header = `${emoji} ${opts.title}`.slice(0, 150);

  const meta = [
    `*Error code:* \`${opts.errorCode}\``,
    opts.userId ? `*User ID:* \`${opts.userId}\`` : null,
    opts.applicationId ? `*Application:* \`${opts.applicationId}\`` : null,
    opts.analysisId ? `*Analysis:* \`${opts.analysisId}\`` : null,
    opts.serviceNo ? `*ServiceNo:* \`${opts.serviceNo}\`` : null,
    `*Status:* ${opts.passed === true ? 'recovered / completed' : opts.passed === false ? 'failed' : 'see issue'}`,
    `*Alert id:* \`${opts.id}\``,
  ]
    .filter(Boolean)
    .join('\n');

  const checkMd = opts.check.length
    ? opts.check.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '_No checklist_';

  const logPreview = opts.logs
    .slice(-8)
    .map((l) => {
      const ok = l.ok === true ? '✓' : '✗';
      const err = typeof l.error === 'string' ? redactText(l.error).slice(0, 120) : '';
      return `${ok} #${l.attempt ?? '?'} ${l.source || ''} ${err}`.trim();
    })
    .join('\n')
    .slice(0, 1800);

  return {
    text: `${opts.errorCode}: ${opts.title} — ${opts.issue}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: header, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*What's wrong*\n${opts.issue}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: meta || '_no ids_' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*What to check*\n${checkMd}` },
      },
      ...(logPreview
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*What we tried*\n\`\`\`${logPreview}\`\`\``,
              },
            },
          ]
        : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${opts.kind} · ${opts.attemptCount} attempt(s) · ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };
}

async function postSlack(body: Record<string, unknown>): Promise<{ ok: boolean; ts?: string; error?: string }> {
  if (!SLACK_ENABLED || !SLACK_WEBHOOK_URL) {
    return { ok: false, error: 'Slack alerts disabled or webhook not configured' };
  }
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Slack HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    // Incoming webhooks usually return "ok"
    return { ok: true, ts: text === 'ok' ? undefined : text.slice(0, 64) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Store alert + notify Slack when attempts >= ALERT_MIN_ATTEMPTS (default 2)
 * or on hard failures. Never throws.
 */
export async function emitAlert(input: EmitAlertInput): Promise<EmitAlertResult> {
  try {
    if (!shouldAlert(input.attemptCount, input.kind, input.passed)) {
      return { slackSent: false, skipped: true, reason: `below threshold (min attempts ${ALERT_MIN_ATTEMPTS})` };
    }

    const logs = redactLogs(Array.isArray(input.logs) ? input.logs : []);
    const userId =
      input.userId ||
      (typeof input.context?.userId === 'string' ? input.context.userId : null) ||
      input.applicationId ||
      null;
    const context = { ...input.context, userId };
    const severity: AlertSeverity =
      input.severity ||
      (input.kind.endsWith('_failed') || input.passed === false ? 'critical' : 'warning');
    const { summary, explanation, title, issue, errorCode, check } = autoExplain({
      kind: input.kind,
      attemptCount: input.attemptCount,
      passed: input.passed,
      logs,
      context,
    });

    const { rows } = await authPool.query(
      `INSERT INTO alerts
         (kind, severity, application_id, analysis_id, service_no, attempt_count, passed,
          summary, explanation, logs, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
       RETURNING id`,
      [
        input.kind,
        severity,
        input.applicationId ?? null,
        input.analysisId ?? null,
        input.serviceNo ?? null,
        input.attemptCount,
        input.passed ?? null,
        summary,
        explanation,
        JSON.stringify(logs),
        JSON.stringify(context),
      ]
    );
    const id = rows[0]?.id as string;

    const slackBody = buildSlackBlocks({
      id,
      kind: input.kind,
      severity,
      title,
      issue,
      errorCode,
      check,
      summary,
      explanation,
      applicationId: input.applicationId,
      analysisId: input.analysisId,
      userId,
      serviceNo: input.serviceNo,
      attemptCount: input.attemptCount,
      passed: input.passed,
      logs,
    });

    const slack = await postSlack(slackBody);
    await authPool.query(
      `UPDATE alerts
          SET slack_sent = $2,
              slack_ts = $3,
              slack_error = $4
        WHERE id = $1`,
      [id, slack.ok, slack.ts ?? null, slack.ok ? null : slack.error ?? null]
    );

    if (!slack.ok) {
      console.error('[alerts] Slack send failed —', slack.error);
    } else {
      console.log(`[alerts] emitted ${input.kind} id=${id} attempts=${input.attemptCount}`);
    }

    return { id, slackSent: slack.ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[alerts] emitAlert failed —', msg);
    // Fallback: still try Slack without DB if migration missing
    try {
      if (SLACK_ENABLED && SLACK_WEBHOOK_URL) {
        await postSlack({
          text: `⚠️ Alert (DB unavailable): ${input.kind} app=${input.applicationId} attempts=${input.attemptCount} — ${msg}`,
        });
      }
    } catch {
      /* ignore */
    }
    return { slackSent: false, reason: msg };
  }
}

/** Fire-and-forget wrapper so request path never waits on Slack/DB. */
export function emitAlertBackground(input: EmitAlertInput): void {
  void emitAlert(input).catch((err) => {
    console.error('[alerts] background emit failed —', err instanceof Error ? err.message : err);
  });
}
