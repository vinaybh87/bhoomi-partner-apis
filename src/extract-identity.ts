// OCR + structure Aadhaar / PAN / combined identity PDFs via AI service.
// Used by investor POST /v1/analysis for document verification.

export type AadhaarExtraction = {
  document_type?: string;
  aadhaar_present?: boolean;
  name?: string | null;
  aadhaar_number?: string | null;
  aadhaar_last4?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  address?: string | null;
  valid_format?: boolean;
  usable?: boolean;
  notes?: string | null;
};

export type PanExtraction = {
  document_type?: string;
  pan_present?: boolean;
  name?: string | null;
  pan_number?: string | null;
  father_name?: string | null;
  date_of_birth?: string | null;
  valid_format?: boolean;
  usable?: boolean;
  notes?: string | null;
};

export type IdentityExtraction = {
  aadhaar?: AadhaarExtraction | null;
  pan?: PanExtraction | null;
  detected_types?: string[];
  usable?: boolean;
  notes?: string | null;
};

export type IdentityAttemptLog = {
  attempt: number;
  at: string;
  ok: boolean;
  error?: string | null;
  durationMs: number;
  source: string;
  httpStatus?: number | null;
  docType?: string;
};

export type IdentityOcrResult = {
  aadhaar: AadhaarExtraction | null;
  pan: PanExtraction | null;
  identityLog: IdentityAttemptLog[];
  /** English summary for document verification remarks */
  summary: string;
  aadhaarValid: boolean;
  panValid: boolean;
};

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8421';
const IDENTITY_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isPanValid(p: PanExtraction | null | undefined): boolean {
  if (!p) return false;
  if (p.usable && p.valid_format) return true;
  const num = (p.pan_number || '').replace(/\s/g, '').toUpperCase();
  return PAN_RE.test(num);
}

export function isAadhaarValid(a: AadhaarExtraction | null | undefined): boolean {
  if (!a) return false;
  if (a.usable && a.valid_format) return true;
  if (a.aadhaar_last4 && /^\d{4}$/.test(a.aadhaar_last4)) return true;
  const digits = (a.aadhaar_number || '').replace(/\D/g, '');
  return digits.length === 12;
}

async function postExtract(
  path: '/extract/aadhaar' | '/extract/pan' | '/extract/identity',
  pdfBuffer: Buffer,
  fileName: string
): Promise<{ ok: boolean; data?: unknown; httpStatus?: number; error?: string; durationMs: number }> {
  const started = Date.now();
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
      fileName
    );
    const res = await fetch(`${AI_SERVICE_URL}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, httpStatus: res.status, error: `AI ${path} HTTP ${res.status}: ${body}`, durationMs };
    }
    const data = await res.json();
    return { ok: true, data, httpStatus: 200, durationMs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

async function withRetries<T>(
  label: string,
  fn: () => Promise<{ ok: boolean; data?: T; httpStatus?: number; error?: string; durationMs: number }>,
  log: IdentityAttemptLog[]
): Promise<T | null> {
  let last: T | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);
    const at = new Date().toISOString();
    const res = await fn();
    const usable =
      res.ok &&
      res.data != null &&
      (label === 'identity'
        ? Boolean((res.data as IdentityExtraction).usable || (res.data as IdentityExtraction).aadhaar || (res.data as IdentityExtraction).pan)
        : label === 'aadhaar'
          ? isAadhaarValid(res.data as AadhaarExtraction) || Boolean((res.data as AadhaarExtraction).aadhaar_present)
          : isPanValid(res.data as PanExtraction) || Boolean((res.data as PanExtraction).pan_present));

    log.push({
      attempt,
      at,
      ok: Boolean(res.ok && usable),
      error: res.ok ? (usable ? null : `${label} OCR returned unusable extraction`) : res.error,
      durationMs: res.durationMs,
      source: `analysis:ocr:${label}`,
      httpStatus: res.httpStatus ?? null,
      docType: label.toUpperCase(),
    });

    if (res.ok && res.data) {
      last = res.data;
      if (usable) return res.data;
    }
  }
  return last;
}

export type InvestorBatchResult = {
  dpr: Record<string, unknown> | null;
  aadhaar: AadhaarExtraction | null;
  pan: PanExtraction | null;
  identity: IdentityExtraction | null;
  errors: Record<string, string>;
  durationMs: number;
  httpStatus: number | null;
  error?: string;
};

/**
 * Single-request parallel OCR for investor docs (Aadhaar + PAN + DPR).
 * The AI service runs Mistral OCR for every uploaded file concurrently.
 */
export async function extractInvestorBatch(opts: {
  dprBuffer?: Buffer | null;
  dprFileName?: string;
  aadhaarBuffer?: Buffer | null;
  aadhaarFileName?: string;
  panBuffer?: Buffer | null;
  panFileName?: string;
  identityBuffer?: Buffer | null;
  identityFileName?: string;
}): Promise<InvestorBatchResult> {
  const started = Date.now();
  const form = new FormData();
  const appendPdf = (field: string, buf: Buffer, name: string) => {
    form.append(field, new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), name);
  };
  if (opts.dprBuffer) appendPdf('dpr', opts.dprBuffer, opts.dprFileName || 'dpr.pdf');
  if (opts.identityBuffer) {
    appendPdf('identity', opts.identityBuffer, opts.identityFileName || 'identity.pdf');
  } else {
    if (opts.aadhaarBuffer) appendPdf('aadhaar', opts.aadhaarBuffer, opts.aadhaarFileName || 'aadhaar.pdf');
    if (opts.panBuffer) appendPdf('pan', opts.panBuffer, opts.panFileName || 'pan.pdf');
  }
  try {
    const res = await fetch(`${AI_SERVICE_URL}/extract/investor`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS + 180_000),
    });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return {
        dpr: null,
        aadhaar: null,
        pan: null,
        identity: null,
        errors: {},
        durationMs,
        httpStatus: res.status,
        error: `AI /extract/investor HTTP ${res.status}: ${body}`,
      };
    }
    const data = (await res.json()) as {
      dpr?: Record<string, unknown> | null;
      aadhaar?: AadhaarExtraction | null;
      pan?: PanExtraction | null;
      identity?: IdentityExtraction | null;
      errors?: Record<string, string>;
    };
    const identity = data.identity ?? null;
    return {
      dpr: data.dpr ?? null,
      aadhaar: data.aadhaar ?? identity?.aadhaar ?? null,
      pan: data.pan ?? identity?.pan ?? null,
      identity,
      errors: data.errors && typeof data.errors === 'object' ? data.errors : {},
      durationMs,
      httpStatus: 200,
    };
  } catch (err) {
    return {
      dpr: null,
      aadhaar: null,
      pan: null,
      identity: null,
      errors: {},
      durationMs: Date.now() - started,
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * OCR identity docs for investor document verification.
 * - Combined identity PDF → /extract/identity once
 * - Separate Aadhaar / PAN buffers → parallel /extract/aadhaar + /extract/pan
 */
export async function extractIdentityDocs(opts: {
  aadhaarBuffer?: Buffer | null;
  panBuffer?: Buffer | null;
  /** Same buffer used for both (NM identity proof pack) */
  combinedBuffer?: Buffer | null;
  aadhaarFileName?: string;
  panFileName?: string;
  combinedFileName?: string;
}): Promise<IdentityOcrResult> {
  const identityLog: IdentityAttemptLog[] = [];
  let aadhaar: AadhaarExtraction | null = null;
  let pan: PanExtraction | null = null;

  const sameFile =
    opts.combinedBuffer ||
    (opts.aadhaarBuffer &&
      opts.panBuffer &&
      opts.aadhaarBuffer.equals(opts.panBuffer));

  if (sameFile) {
    const buf = opts.combinedBuffer || opts.aadhaarBuffer!;
    const fileName = opts.combinedFileName || opts.aadhaarFileName || 'identity.pdf';
    const data = await withRetries<IdentityExtraction>(
      'identity',
      () => postExtract('/extract/identity', buf, fileName) as Promise<{
        ok: boolean;
        data?: IdentityExtraction;
        httpStatus?: number;
        error?: string;
        durationMs: number;
      }>,
      identityLog
    );
    if (data) {
      aadhaar = data.aadhaar ?? null;
      pan = data.pan ?? null;
    }
  } else {
    const jobs: Promise<void>[] = [];
    if (opts.aadhaarBuffer) {
      jobs.push(
        (async () => {
          const data = await withRetries<AadhaarExtraction>(
            'aadhaar',
            () =>
              postExtract(
                '/extract/aadhaar',
                opts.aadhaarBuffer!,
                opts.aadhaarFileName || 'aadhaar.pdf'
              ) as Promise<{
                ok: boolean;
                data?: AadhaarExtraction;
                httpStatus?: number;
                error?: string;
                durationMs: number;
              }>,
            identityLog
          );
          aadhaar = data;
        })()
      );
    }
    if (opts.panBuffer) {
      jobs.push(
        (async () => {
          const data = await withRetries<PanExtraction>(
            'pan',
            () =>
              postExtract('/extract/pan', opts.panBuffer!, opts.panFileName || 'pan.pdf') as Promise<{
                ok: boolean;
                data?: PanExtraction;
                httpStatus?: number;
                error?: string;
                durationMs: number;
              }>,
            identityLog
          );
          pan = data;
        })()
      );
    }
    await Promise.all(jobs);
  }

  const aadhaarValid = isAadhaarValid(aadhaar);
  const panValid = isPanValid(pan);
  const summary = buildIdentitySummary({
    aadhaar,
    pan,
    aadhaarValid,
    panValid,
    aadhaarUploaded: Boolean(opts.aadhaarBuffer || opts.combinedBuffer),
    panUploaded: Boolean(opts.panBuffer || opts.combinedBuffer),
  });

  return {
    aadhaar,
    pan,
    identityLog,
    summary,
    aadhaarValid,
    panValid,
  };
}

export function buildIdentitySummary(opts: {
  aadhaar: AadhaarExtraction | null;
  pan: PanExtraction | null;
  aadhaarValid: boolean;
  panValid: boolean;
  aadhaarUploaded: boolean;
  panUploaded: boolean;
}): string {
  const { aadhaar, pan, aadhaarValid, panValid } = opts;
  const parts: string[] = [];
  if (aadhaarValid) {
    const mask = aadhaar?.aadhaar_last4
      ? `ending ${aadhaar.aadhaar_last4}`
      : aadhaar?.aadhaar_number
        ? 'number readable'
        : 'details present';
    parts.push(
      `Aadhaar OCR valid (${aadhaar?.name ? `name: ${aadhaar.name}; ` : ''}${mask}).`
    );
  } else if (opts.aadhaarUploaded) {
    parts.push(
      `Aadhaar OCR failed or invalid${aadhaar?.notes ? ` — ${aadhaar.notes}` : ' — no usable number or name'}.`
    );
  } else {
    parts.push('Aadhaar document was not uploaded.');
  }

  if (panValid) {
    const panNum = pan?.pan_number ? pan.pan_number.toUpperCase() : '';
    parts.push(
      `PAN OCR valid${pan?.name ? ` (name: ${pan.name}` : ''}${panNum ? `${pan?.name ? '; ' : ' ('}PAN: ${panNum}` : ''}${pan?.name || panNum ? ')' : ''}.`
    );
  } else if (opts.panUploaded) {
    parts.push(
      `PAN OCR failed or invalid${pan?.notes ? ` — ${pan.notes}` : ' — no valid PAN number found'}.`
    );
  } else {
    parts.push('PAN document was not uploaded.');
  }

  return parts.join(' ');
}
