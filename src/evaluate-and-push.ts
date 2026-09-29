// Payment-triggered evaluation pipeline:
// load NM analysis → OCR if needed → marks → AI evaluate (up to 3 attempts)
// → store evaluation_check → SaveAssessment.
import { authPool, bhoomiPool } from './db.js';
import { calcScore, type OCRData, type ScoreResult } from './marks.js';
import { Buffer } from 'buffer';
import { pushSaveAssessment, type SaveAssessmentPayload } from './upsida-assessment.js';
import {
  renderAssessmentHtml,
  type HistoryVerification,
  type McaVerification,
} from './render-assessment-html.js';
import { extractDprWithRetries, isUsableExtraction } from './extract-dpr.js';
import { loadDocumentBytes } from './minio-store.js';
import { emitAlertBackground, type AlertLogEntry } from './alerts.js';
import { collectDocumentEvidence, mergeOcrWithEvidence } from './document-evidence.js';
import { completeChecks } from './analysis-payload.js';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8421';
const MAX_AI_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

export type PipelinePushResult = {
  ok: boolean;
  evaluationCheckId?: string;
  attempt_count: number;
  error?: string;
  error_msg?: string | null;
  httpStatus?: number;
  detail?: unknown;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolvePricePerSqm(application: {
  industrialArea?: string;
  district?: string;
  landAreaSqm?: number;
}): Promise<number> {
  if (application.industrialArea) {
    const params: unknown[] = [application.industrialArea];
    let query = 'SELECT price_per_sqm FROM land_value WHERE industrial_area = $1';
    if (application.district) {
      query += ' AND district = $2';
      params.push(application.district);
    }
    query += ' LIMIT 1';
    const { rows } = await bhoomiPool.query(query, params);
    if (rows[0]?.price_per_sqm != null) return Number(rows[0].price_per_sqm);
  }
  return 0;
}

async function ensureExtraction(
  extraction: OCRData | null,
  documents: Array<{
    docType?: string;
    url?: string;
    fileName?: string;
    objectKey?: string;
    storage?: string;
  }> | null,
  opts?: { analysisId?: string; existingOcrLog?: unknown; existingOcrAttemptCount?: number }
): Promise<OCRData> {
  if (extraction && typeof extraction === 'object' && isUsableExtraction(extraction)) {
    return extraction;
  }

  const docs = Array.isArray(documents) ? documents : [];
  // Prefer MinIO-backed DPR (objectKey); fall back to any DPR with a url.
  const dpr = docs.find((d) => d.docType === 'DPR' && (d.objectKey || d.url))
    ?? docs.find((d) => d.docType === 'DPR');
  if (!dpr?.objectKey && !dpr?.url) {
    throw new Error('No stored extraction and no DPR document (MinIO key or URL) to re-extract');
  }

  const buffer = await loadDocumentBytes({
    objectKey: dpr.objectKey,
    url: dpr.url,
    storage: dpr.storage,
  });

  const ocrResult = await extractDprWithRetries(buffer, {
    fileName: dpr.fileName || 'dpr.pdf',
    source: 'payment_reextract',
  });

  const priorLog = Array.isArray(opts?.existingOcrLog) ? opts!.existingOcrLog : [];
  const mergedLog = [...priorLog, ...ocrResult.ocrLog];
  const mergedCount = (Number(opts?.existingOcrAttemptCount) || 0) + ocrResult.ocrAttemptCount;

  if (opts?.analysisId) {
    await authPool.query(
      `UPDATE nm_response
          SET extraction = $2,
              ocr_log = $3::jsonb,
              ocr_attempt_count = $4
        WHERE analysis_id = $1`,
      [
        opts.analysisId,
        JSON.stringify(ocrResult.extraction),
        JSON.stringify(mergedLog),
        mergedCount,
      ]
    );
  }

  if (!ocrResult.usable && ocrResult.ocrLog.every((e) => e.httpStatus !== 200)) {
    const last = ocrResult.ocrLog[ocrResult.ocrLog.length - 1];
    throw new Error(last?.error || 'OCR re-extract failed after retries');
  }

  return ocrResult.extraction as OCRData;
}

async function verifyMca(cin: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${AI_SERVICE_URL}/verify/mca`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cin }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI /verify/mca HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function verifyGstin(gstin: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${AI_SERVICE_URL}/verify/gstin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gstin }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI /verify/gstin HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function callEvaluate(
  dpr: OCRData,
  gstin: Record<string, unknown>
): Promise<{ comparisons: unknown; flags: unknown; summary: unknown }> {
  const res = await fetch(`${AI_SERVICE_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dpr, gstin }),
    signal: AbortSignal.timeout(110_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI /evaluate HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as { comparisons: unknown; flags: unknown; summary: unknown };
}

// UPSIDA "Objective Criteria" UI field names — rename only (scores unchanged).
const UPSIDA_MARKS_FIELD_NAMES: Record<string, string> = {
  direct_employment: 'Employment (In Numbers)',
  promoter_experience: 'Work Experience (In Year)',
  time_to_production: 'Start Period (In Months)',
  expansion_unit: 'Project Expansion',
  export_oriented: 'If Export Oriented',
  entrepreneur_category: 'Priority Category',
  net_worth_turnover: 'Net Worth (In Lacs)',
  // Closest UPSIDA form labels for remaining score rows:
  investment_ratio: 'In Land (In Lacs)',
  liquidity: 'In Machinery (In Lacs)',
  fdi_proposal: 'In Plant or Building (In Lacs)',
};

/** CMS hardcodes these marks parameter names — always send all, empty if we have no score. */
const CMS_MARKS_PARAMETERS: { parameter: string; max: number }[] = [
  { parameter: 'In Land (In Lacs)', max: 10 },
  { parameter: 'In Machinery (In Lacs)', max: 20 },
  { parameter: 'Employment (In Numbers)', max: 10 },
  { parameter: 'Work Experience (In Year)', max: 20 },
  { parameter: 'Start Period (In Months)', max: 20 },
  { parameter: 'Project Expansion', max: 10 },
  { parameter: 'If Export Oriented', max: 5 },
  { parameter: 'Priority Category', max: 5 },
  { parameter: 'Net Worth (In Lacs)', max: 15 },
  { parameter: 'In Plant or Building (In Lacs)', max: 5 },
];

/** CMS hardcodes these comparison labels — always send all, empty strings if unknown. */
const CMS_COMPARISON_LABELS = [
  'Company Name',
  'Applicant Name',
  'Registered Address',
  'Constitution',
  'Promoter / Directors',
  'Proposed Activity',
  'Proposed Investment',
  'GSTIN Status',
  'Filing Regularity',
  'Year of Establishment',
  'Turnover',
] as const;

type CmsMarkRow = { parameter: string; score: number; max: number; insight: string };
type CmsComparison = { label: string; dpr_value: string; gst_value: string; note: string };

function emptyStr(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

function completeMarksParameters(rows: CmsMarkRow[]): CmsMarkRow[] {
  const byName = new Map(rows.map((r) => [r.parameter, r]));
  return CMS_MARKS_PARAMETERS.map((slot) => {
    const hit = byName.get(slot.parameter);
    if (!hit) {
      return { parameter: slot.parameter, score: 0, max: slot.max, insight: '' };
    }
    return {
      parameter: hit.parameter,
      score: Number.isFinite(hit.score) ? hit.score : 0,
      max: Number.isFinite(hit.max) ? hit.max : slot.max,
      insight: emptyStr(hit.insight),
    };
  });
}

function completeComparisons(raw: unknown): CmsComparison[] {
  const incoming = Array.isArray(raw) ? raw : [];
  const byLabel = new Map<string, Record<string, unknown>>();
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const label = emptyStr(row.label);
    if (label) byLabel.set(label.toLowerCase(), row);
  }
  const used = new Set<string>();
  const out: CmsComparison[] = CMS_COMPARISON_LABELS.map((label) => {
    const hit = byLabel.get(label.toLowerCase());
    if (hit) used.add(label.toLowerCase());
    return {
      label,
      dpr_value: emptyStr(hit?.dpr_value),
      gst_value: emptyStr(hit?.gst_value),
      note: emptyStr(hit?.note),
    };
  });
  for (const [key, hit] of byLabel) {
    if (used.has(key)) continue;
    out.push({
      label: emptyStr(hit.label) || key,
      dpr_value: emptyStr(hit.dpr_value),
      gst_value: emptyStr(hit.gst_value),
      note: emptyStr(hit.note),
    });
  }
  return out;
}

function completeSummary(raw: unknown, skippedGst: boolean): {
  headline: string;
  lean: string;
  narrative: string;
  strengths: string[];
  concerns: string[];
} {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const strengths = Array.isArray(s.strengths) ? s.strengths.map((x) => emptyStr(x)).filter(Boolean) : [];
  const concerns = Array.isArray(s.concerns) ? s.concerns.map((x) => emptyStr(x)).filter(Boolean) : [];
  return {
    headline: emptyStr(s.headline) || (skippedGst ? 'Marks evaluation completed' : ''),
    lean: emptyStr(s.lean) || (skippedGst ? 'review' : ''),
    narrative:
      emptyStr(s.narrative) ||
      (skippedGst ? 'GST / MCA compare was not available — marks only. Assessment still sent.' : ''),
    strengths,
    concerns,
  };
}

type FlagRow = {
  number: string;
  stage: string;
  check: string;
  status: string;
  passed: boolean | null;
  remarks: string;
  source: string;
  severity: string;
  title: string;
  detail: string;
  external_ref: string;
};

function severityForCheck(status: string, passed: boolean | null): string {
  if (passed === true || status.toLowerCase() === 'passed') return 'verified';
  if (status.toLowerCase() === 'pending') return 'info';
  return 'warning';
}

function flagsFromInvestorChecks(storedResponse: unknown): FlagRow[] {
  const body =
    storedResponse && typeof storedResponse === 'object'
      ? (storedResponse as Record<string, unknown>)
      : {};
  const raw = Array.isArray(body.checks)
    ? body.checks
    : Array.isArray(body.checkResults)
      ? body.checkResults
      : [];
  if (!raw.length) return [];
  return completeChecks(raw).map((c) => ({
    number: String(c.number),
    stage: c.stage,
    check: c.check,
    status: c.status,
    passed: c.passed,
    remarks: c.remarks,
    source: 'Investor analysis',
    severity: severityForCheck(c.status, c.passed),
    title: c.check,
    detail: c.remarks,
    external_ref: `Check ${c.number}`,
  }));
}

function completeFlags(raw: unknown): FlagRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const f = item as Record<string, unknown>;
      const status = emptyStr(f.status);
      const passed =
        f.passed === true ? true : f.passed === false ? false : null;
      const check = emptyStr(f.check) || emptyStr(f.title);
      const remarks = emptyStr(f.remarks) || emptyStr(f.detail);
      const severity =
        emptyStr(f.severity) || severityForCheck(status, passed);
      return {
        number: f.number == null ? '' : String(f.number),
        stage: emptyStr(f.stage) || emptyStr(f.source) || 'Investor analysis',
        check,
        status: status || (passed === true ? 'Passed' : passed === false ? 'Flagged' : ''),
        passed,
        remarks,
        source: emptyStr(f.source) || 'Investor analysis',
        severity,
        title: emptyStr(f.title) || check,
        detail: emptyStr(f.detail) || remarks,
        external_ref: emptyStr(f.external_ref),
      };
    });
}

function mergeFlags(investor: FlagRow[], aiRaw: unknown): FlagRow[] {
  const ai = completeFlags(aiRaw).filter((row) => {
    const key = `${row.check}|${row.remarks}`.toLowerCase();
    return !investor.some((c) => `${c.check}|${c.remarks}`.toLowerCase() === key);
  });
  return [...investor, ...ai];
}

function upsidaMarksParameterName(row: { key?: string; label?: string }): string {
  if (row.key && UPSIDA_MARKS_FIELD_NAMES[row.key]) {
    return UPSIDA_MARKS_FIELD_NAMES[row.key];
  }
  const label = (row.label || '').toLowerCase();
  if (label.includes('employment')) return 'Employment (In Numbers)';
  if (label.includes('experience')) return 'Work Experience (In Year)';
  if (label.includes('time to start') || label.includes('production')) {
    return 'Start Period (In Months)';
  }
  if (label.includes('expansion')) return 'Project Expansion';
  if (label.includes('export')) return 'If Export Oriented';
  if (label.includes('women') || label.includes('sc / st') || label.includes('differently')) {
    return 'Priority Category';
  }
  if (label.includes('net worth') || label.includes('turnover')) return 'Net Worth (In Lacs)';
  if (label.includes('liquidity')) return 'In Machinery (In Lacs)';
  if (label.includes('fdi')) return 'In Plant or Building (In Lacs)';
  if (label.includes('investment') || label.includes('land cost')) return 'In Land (In Lacs)';
  return row.label || row.key || 'Unknown';
}

/** Mock MCA (mca.gov.in-style) block for SaveAssessment until live MCA API is wired. */
export function buildMockMcaVerification(opts: {
  applicationId: string;
  companyName?: string | null;
}): McaVerification {
  const name = (opts.companyName || 'UNKNOWN COMPANY').toUpperCase().trim();
  // Deterministic pseudo-CIN from applicationId for stable mocks
  const seed = opts.applicationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || '00000000';
  const cin = `U${seed.slice(0, 5)}UP2019PTC${seed.slice(-5).padStart(5, '0')}`;
  return {
    status: 'MOCK',
    source: 'mca.gov.in (mock)',
    cin,
    companyName: name,
    companyStatus: 'Active',
    dateOfIncorporation: '2019-06-15',
    registeredAddress: 'Registered office as per MCA records (mock)',
    directors: [
      { name: 'Director One (mock)', designation: 'Director' },
      { name: 'Director Two (mock)', designation: 'Director' },
    ],
    findings: [
      {
        severity: 'info',
        title: 'MCA company status Active',
        detail: `Mock MCA lookup for ${name} returned company status Active under CIN ${cin}.`,
      },
      {
        severity: 'info',
        title: 'Director records available',
        detail: 'Mock mca.gov.in response includes 2 active directors for cross-check against DPR promoters.',
      },
    ],
  };
}

function historyFromAnalysis(storedResponse: unknown): HistoryVerification {
  const response = storedResponse && typeof storedResponse === 'object'
    ? storedResponse as Record<string, unknown>
    : {};
  const history = response.applicantHistory && typeof response.applicantHistory === 'object'
    ? response.applicantHistory as Record<string, unknown>
    : {};
  const priorApplications = Array.isArray(history.priorApplications)
    ? history.priorApplications.filter((item) => item && typeof item === 'object')
    : [];
  const unavailable = history.status === 'UNAVAILABLE';
  const hasAppliedBefore = history.hasAppliedBefore === true && priorApplications.length > 0;
  return {
    status: unavailable ? 'UNAVAILABLE' : hasAppliedBefore ? 'FOUND' : 'NO_PRIOR_APPLICATION',
    hasAppliedBefore,
    message: unavailable
      ? 'History lookup unavailable.'
      : hasAppliedBefore ? 'Prior land allotments found.' : 'No prior application.',
    priorApplications: priorApplications as HistoryVerification['priorApplications'],
  };
}

function buildPayload(
  applicationId: string,
  marks: ScoreResult,
  ai: { comparisons: unknown; flags: unknown; summary: unknown } | null,
  opts?: { companyName?: string | null; storedResponse?: unknown }
): SaveAssessmentPayload {
  const skippedGst = !ai;
  const summaryObj = completeSummary(ai?.summary, skippedGst);
  const flags = mergeFlags(flagsFromInvestorChecks(opts?.storedResponse), ai?.flags);

  const generatedAt = new Date().toISOString();
  const mcaVerification = buildMockMcaVerification({
    applicationId,
    companyName: opts?.companyName,
  });
  const historyVerification = historyFromAnalysis(opts?.storedResponse);

  const scored = marks.rows.map((row) => ({
    parameter: upsidaMarksParameterName(row),
    score: row.score,
    max: row.max,
    insight: row.note || '',
  }));

  const base = {
    applicationId,
    assessmentVersion: 1 as const,
    generatedAt,
    aiSuggestedScore: {
      value: marks.total,
      scale: marks.maxScore,
      passMark: marks.passMark,
    },
    marksEvaluation: {
      total: marks.total,
      max: marks.maxScore,
      passMark: marks.passMark,
      result: (marks.total >= marks.passMark
        ? 'AT_OR_ABOVE_PASS_MARK'
        : 'BELOW_PASS_MARK') as 'AT_OR_ABOVE_PASS_MARK' | 'BELOW_PASS_MARK',
      parameters: completeMarksParameters(scored),
    },
    comparisons: completeComparisons(ai?.comparisons),
    flags,
    summary: summaryObj,
    mcaVerification,
    historyVerification,
  };

  // Combined mockup HTML + CSS as one compact string, then base64 for the wire.
  const HTMLDetails = Buffer.from(renderAssessmentHtml(base), 'utf8').toString('base64');

  return {
    applicationId: base.applicationId,
    assessmentVersion: base.assessmentVersion,
    HTMLDetails,
    generatedAt: base.generatedAt,
    aiSuggestedScore: base.aiSuggestedScore,
    marksEvaluation: base.marksEvaluation,
    comparisons: base.comparisons,
    flags: base.flags,
    summary: base.summary,
    mcaVerification: base.mcaVerification,
    historyVerification: base.historyVerification,
  };
}

async function updateCheck(
  id: string,
  fields: {
    attempt_count?: number;
    evaluation?: unknown;
    error_msg?: string | null;
    status?: string;
    upsida_push?: unknown;
    /** True only after successful SaveAssessment to UPSIDA. */
    upsida?: boolean;
    document_evidence?: unknown;
  }
) {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  let i = 1;
  if (fields.attempt_count !== undefined) {
    sets.push(`attempt_count = $${i++}`);
    vals.push(fields.attempt_count);
  }
  if (fields.evaluation !== undefined) {
    sets.push(`evaluation = $${i++}`);
    vals.push(fields.evaluation == null ? null : JSON.stringify(fields.evaluation));
  }
  if (fields.error_msg !== undefined) {
    sets.push(`error_msg = $${i++}`);
    vals.push(fields.error_msg);
  }
  if (fields.status !== undefined) {
    sets.push(`status = $${i++}`);
    vals.push(fields.status);
  }
  if (fields.upsida_push !== undefined) {
    sets.push(`upsida_push = $${i++}`);
    vals.push(fields.upsida_push == null ? null : JSON.stringify(fields.upsida_push));
  }
  if (fields.upsida !== undefined) {
    sets.push(`upsida = $${i++}`);
    vals.push(fields.upsida);
  }
  if (fields.document_evidence !== undefined) {
    sets.push(`document_evidence = $${i++}`);
    vals.push(
      fields.document_evidence == null ? null : JSON.stringify(fields.document_evidence)
    );
  }
  vals.push(id);
  await authPool.query(
    `UPDATE evaluation_check SET ${sets.join(', ')} WHERE id = $${i}`,
    vals
  );
}

/** Create a running evaluation_check row and return its id (caller can respond immediately). */
export async function beginEvaluationCheck(
  applicationId: string,
  serviceNo: string
): Promise<string> {
  const ins = await authPool.query(
    `INSERT INTO evaluation_check (application_id, service_no, attempt_count, status)
     VALUES ($1, $2, 0, 'running')
     RETURNING id`,
    [applicationId, serviceNo]
  );
  return ins.rows[0].id as string;
}

/**
 * Full post-payment pipeline. Never throws — returns upsidaPush-shaped result.
 * When evaluation succeeds, SaveAssessment is called immediately (no extra delay).
 * Pass checkId from beginEvaluationCheck if the HTTP response already returned.
 */
export async function runPaymentEvaluationAndPush(opts: {
  applicationId: string;
  serviceNo: string;
  checkId?: string;
}): Promise<PipelinePushResult> {
  const { applicationId, serviceNo } = opts;
  let checkId: string | undefined = opts.checkId;
  let attemptCount = 0;

  try {
    if (!checkId) {
      checkId = await beginEvaluationCheck(applicationId, serviceNo);
    }

    const { rows } = await authPool.query(
      `SELECT analysis_id, applicant, application, documents, extraction,
              ocr_log, ocr_attempt_count, token_claims, response
         FROM nm_response
        WHERE application_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [applicationId]
    );
    const row = rows[0];
    if (!row) {
      const msg = 'No analysis on file for this applicationId — run /v1/analysis first';
      await updateCheck(checkId, { status: 'failed', error_msg: msg, attempt_count: 0 });
      return {
        ok: false,
        evaluationCheckId: checkId,
        attempt_count: 0,
        error: msg,
        error_msg: msg,
      };
    }

    const applicant = (row.applicant ?? {}) as {
      gstin?: string;
      cin?: string;
      companyName?: string;
    };
    const tokenClaims = (row.token_claims ?? {}) as { userId?: string | null; name?: string | null };
    const userId = (tokenClaims.userId && String(tokenClaims.userId).trim()) || applicationId;
    const application = (row.application ?? {}) as {
      industrialArea?: string;
      district?: string;
      landAreaSqm?: number;
    };
    const documents = row.documents as Array<{
      docType?: string;
      url?: string;
      fileName?: string;
      objectKey?: string;
      storage?: string;
    }> | null;

    let ocr: OCRData;
    try {
      ocr = await ensureExtraction((row.extraction as OCRData) ?? null, documents, {
        analysisId: row.analysis_id as string,
        existingOcrLog: row.ocr_log,
        existingOcrAttemptCount: Number(row.ocr_attempt_count) || 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateCheck(checkId, { status: 'failed', error_msg: msg, attempt_count: 0 });
      return {
        ok: false,
        evaluationCheckId: checkId,
        attempt_count: 0,
        error: 'OCR / extraction failed',
        error_msg: msg,
      };
    }

    // Multi-doc OCR: originality + validity of supporting certificates, then patch OCR for marks.
    let documentEvidence: Awaited<ReturnType<typeof collectDocumentEvidence>> | null = null;
    try {
      console.log(`[EVAL] Document evidence OCR for ${applicationId} (${(documents || []).length} docs)`);
      documentEvidence = await collectDocumentEvidence(documents);
      ocr = mergeOcrWithEvidence(ocr, documentEvidence.ocrPatch);
      console.log(`[EVAL] Document evidence: ${documentEvidence.summary}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[EVAL] document evidence OCR failed —', msg);
      // Without verified certs, strip cert-backed fields so marks are not awarded on claims alone
      ocr = mergeOcrWithEvidence(ocr, {
        liquidity_udin: 'no',
        export_turnover_percent: null,
        document_evidence: {
          ca_liquidity_verified: false,
          export_certificate_verified: false,
          error: msg,
        },
      });
    }

    const areaSqm = Number(application.landAreaSqm ?? ocr.land_required_sqm ?? 0) || 0;
    let pricePerSqm = 0;
    try {
      pricePerSqm = await resolvePricePerSqm(application);
    } catch {
      pricePerSqm = 0;
    }
    // If no official rate, derive rough rate from DPR land cost so calcScore still runs.
    if (pricePerSqm <= 0 && areaSqm > 0 && ocr.land_cost_lacs != null) {
      const landCostLacs = Number(ocr.land_cost_lacs) || 0;
      if (landCostLacs > 0) pricePerSqm = (landCostLacs * 100_000) / areaSqm;
    }

    let marks: ScoreResult;
    try {
      marks = calcScore(ocr, areaSqm || 1, pricePerSqm || 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateCheck(checkId, { status: 'failed', error_msg: msg, attempt_count: 0 });
      return {
        ok: false,
        evaluationCheckId: checkId,
        attempt_count: 0,
        error: 'Marks evaluation failed',
        error_msg: msg,
      };
    }

    const gstin = typeof applicant.gstin === 'string' ? applicant.gstin.trim() : '';
    let aiResult: { comparisons: unknown; flags: unknown; summary: unknown } | null = null;
    let lastAiError: string | null = null;
    let lastFailStep: 'gst' | 'evaluate' | null = null;

    const aiAttemptLogs: AlertLogEntry[] = [];
    if (gstin) {
      for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
        attemptCount = attempt;
        await updateCheck(checkId, { attempt_count: attemptCount });
        const started = Date.now();
        try {
          console.log(`[EVAL] GST verify attempt ${attempt}/${MAX_AI_ATTEMPTS} for ${applicationId}`);
          const gstData = await verifyGstin(gstin);
          try {
            console.log(`[EVAL] AI evaluate attempt ${attempt}/${MAX_AI_ATTEMPTS} for ${applicationId}`);
            aiResult = await callEvaluate(ocr, gstData);
            lastAiError = null;
            lastFailStep = null;
            aiAttemptLogs.push({
              attempt,
              at: new Date().toISOString(),
              ok: true,
              error: null,
              durationMs: Date.now() - started,
              source: 'payment:ai_evaluate',
              httpStatus: 200,
            });
            break;
          } catch (err) {
            lastFailStep = 'evaluate';
            lastAiError = err instanceof Error ? err.message : String(err);
            console.error(`[EVAL] /evaluate attempt ${attempt} failed —`, lastAiError);
            aiAttemptLogs.push({
              attempt,
              at: new Date().toISOString(),
              ok: false,
              error: lastAiError,
              durationMs: Date.now() - started,
              source: 'payment:ai_evaluate',
              httpStatus: null,
            });
          }
        } catch (err) {
          lastFailStep = 'gst';
          lastAiError = err instanceof Error ? err.message : String(err);
          console.error(`[EVAL] /verify/gstin attempt ${attempt} failed —`, lastAiError);
          aiAttemptLogs.push({
            attempt,
            at: new Date().toISOString(),
            ok: false,
            error: lastAiError,
            durationMs: Date.now() - started,
            source: 'payment:gst_verify',
            httpStatus: null,
          });
        }
        if (attempt < MAX_AI_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
      }

      if (!aiResult) {
        const failedLogs = aiAttemptLogs.filter((l) => l.ok === false);
        const gstDied =
          lastFailStep === 'gst' ||
          (failedLogs.length > 0 && failedLogs.every((l) => l.source === 'payment:gst_verify'));
        const kind = gstDied ? 'gst_api_failed' : 'payment_eval_failed';
        const autoMsg = gstDied
          ? 'GST API failed after 3 attempts — sending marks to UPSIDA without GST compare'
          : 'AI evaluate failed after 3 attempts — sending marks to UPSIDA without GST compare';
        const error_msg = lastAiError || autoMsg;
        console.error(`[EVAL] ${autoMsg}`);
        emitAlertBackground({
          kind,
          severity: 'critical',
          applicationId,
          userId,
          serviceNo,
          attemptCount,
          passed: false,
          logs: aiAttemptLogs,
          context: { error_msg, evaluationCheckId: checkId, failStep: lastFailStep, gstin, userId },
        });
        // Do not return — marks still go to UPSIDA.
      }

      if (attemptCount >= 2) {
        emitAlertBackground({
          kind: 'payment_eval_retry',
          severity: 'warning',
          applicationId,
          serviceNo,
          attemptCount,
          passed: true,
          logs: aiAttemptLogs,
          context: { evaluationCheckId: checkId, note: 'AI evaluate succeeded after retries' },
        });
      }
    } else {
      // No GSTIN — marks-only; still tell Slack so it is not confused with GST API down.
      console.log(`[EVAL] No GSTIN for ${applicationId} — marks-only evaluation`);
      emitAlertBackground({
        kind: 'gst_details_missing',
        severity: 'warning',
        applicationId,
        userId,
        serviceNo,
        attemptCount: 1,
        passed: true,
        logs: [
          {
            attempt: 1,
            at: new Date().toISOString(),
            ok: false,
            error: `user ${userId}: applicant.gstin is empty — GST vs DPR compare skipped`,
            source: 'payment:gst_verify',
            httpStatus: null,
          },
        ],
        context: {
          evaluationCheckId: checkId,
          userId,
          note: 'Marks-only evaluation; GST number was not on the applicant',
        },
      });
    }

    const cin = typeof applicant.cin === 'string' ? applicant.cin.trim() : '';
    if (cin) {
      try {
        console.log(`[EVAL] MCA verify for ${applicationId}`);
        await verifyMca(cin);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[EVAL] /verify/mca failed —`, msg);
        emitAlertBackground({
          kind: 'mca_api_failed',
          severity: 'warning',
          applicationId,
          userId,
          serviceNo,
          attemptCount: 1,
          passed: false,
          logs: [
            {
              attempt: 1,
              at: new Date().toISOString(),
              ok: false,
              error: msg,
              source: 'payment:mca_verify',
              httpStatus: null,
            },
          ],
          context: { evaluationCheckId: checkId, cin, error_msg: msg, userId },
        });
      }
    } else {
      emitAlertBackground({
        kind: 'mca_details_missing',
        severity: 'warning',
        applicationId,
        userId,
        serviceNo,
        attemptCount: 1,
        passed: true,
        logs: [
          {
            attempt: 1,
            at: new Date().toISOString(),
            ok: false,
            error: `user ${userId}: applicant.cin is empty — MCA lookup skipped`,
            source: 'payment:mca_verify',
            httpStatus: null,
          },
        ],
        context: { evaluationCheckId: checkId, userId, note: 'MCA number was not on the applicant' },
      });
    }

    const payload = buildPayload(applicationId, marks, aiResult, {
      companyName: applicant.companyName ?? null,
      storedResponse: row.response,
    });

    // Internal tracking only — do not expose document_evidence on UI / partner payloads.
    const evidencePayload = documentEvidence
      ? {
          summary: documentEvidence.summary,
          caLiquidityVerified: documentEvidence.caLiquidityVerified,
          exportCertVerified: documentEvidence.exportCertVerified,
          documents: documentEvidence.documents,
        }
      : null;

    await updateCheck(checkId, {
      status: 'succeeded',
      attempt_count: attemptCount,
      // Public evaluation payload for UPSIDA / consumers — no documentEvidence field
      evaluation: payload,
      // Ops tracking column only
      document_evidence: evidencePayload,
      error_msg: lastAiError,
    });

    // Send to UPSIDA the moment evaluation is ready.
    console.log(`[EVAL] AI ready for ${applicationId} — pushing SaveAssessment immediately`);
    const push = await pushSaveAssessment(serviceNo, payload);
    await updateCheck(checkId, {
      upsida_push: push,
      upsida: push.ok === true,
    });
    if (push.ok) {
      console.log(`[EVAL] SaveAssessment ok for ${serviceNo} (check ${checkId})`);
    } else {
      console.error(`[EVAL] SaveAssessment failed for ${serviceNo} —`, push.error);
      emitAlertBackground({
        kind: 'upsida_push_failed',
        severity: 'critical',
        applicationId,
        serviceNo,
        attemptCount: attemptCount || 1,
        passed: false,
        logs: [
          {
            attempt: 1,
            at: new Date().toISOString(),
            ok: false,
            error: push.error || 'SaveAssessment failed',
            source: 'payment:upsida_push',
            httpStatus: push.httpStatus ?? null,
          },
        ],
        context: {
          evaluationCheckId: checkId,
          detail: push.detail ?? null,
        },
      });
    }

    if (!push.ok) {
      return {
        ok: false,
        evaluationCheckId: checkId,
        attempt_count: attemptCount,
        error: push.error || 'SaveAssessment failed',
        error_msg: push.error,
        httpStatus: push.httpStatus,
        detail: push.detail,
      };
    }

    return {
      ok: true,
      evaluationCheckId: checkId,
      attempt_count: attemptCount,
      httpStatus: push.httpStatus,
      detail: push.detail,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[EVAL] pipeline failed —', msg);
    if (checkId) {
      await updateCheck(checkId, {
        status: 'failed',
        attempt_count: attemptCount,
        error_msg: msg,
      }).catch(() => {});
    }
    emitAlertBackground({
      kind: 'payment_eval_failed',
      severity: 'critical',
      applicationId,
      serviceNo,
      attemptCount: attemptCount || 1,
      passed: false,
      logs: [
        {
          attempt: attemptCount || 1,
          at: new Date().toISOString(),
          ok: false,
          error: msg,
          source: 'payment:pipeline',
        },
      ],
      context: { evaluationCheckId: checkId },
    });
    return {
      ok: false,
      evaluationCheckId: checkId,
      attempt_count: attemptCount,
      error: 'Evaluation pipeline failed',
      error_msg: msg,
    };
  }
}
