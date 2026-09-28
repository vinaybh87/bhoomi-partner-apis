// Shared DPR OCR client: wait for completion, retry on failure / empty result.
// Used by POST /v1/analysis and post-payment re-extraction.

export interface OcrAttemptLog {
  attempt: number;
  at: string;
  ok: boolean;
  error?: string | null;
  durationMs: number;
  fieldCount: number;
  hadSignature: boolean;
  source: 'analysis' | 'payment_reextract' | string;
  httpStatus?: number | null;
}

export interface ExtractDprResult<T = Record<string, unknown>> {
  extraction: T;
  ocrLog: OcrAttemptLog[];
  ocrAttemptCount: number;
  /** True if extraction looks usable (core fields or signature present). */
  usable: boolean;
}

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8421';

/** Initial attempt + 2 retries = 3 total. */
export const OCR_MAX_ATTEMPTS = 3;
/** Per-attempt wait for /extract/dpr to finish (ms). */
export const OCR_ATTEMPT_TIMEOUT_MS = 180_000;
/** Delay before retry 2 and 3 (ms). */
export const OCR_RETRY_DELAYS_MS = [2_000, 4_000];

const CORE_FIELDS = [
  'company_name',
  'promoter_name',
  'proposed_activity',
  'total_project_cost_lacs',
  'land_required_sqm',
  'total_employees',
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countPopulatedFields(extraction: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(extraction)) {
    if (k === 'field_confidence' || k === 'signature') continue;
    if (v == null || v === '') continue;
    n += 1;
  }
  return n;
}

/** OCR "happened" if we got a signature object or any required completeness field. */
export function isUsableExtraction(extraction: unknown): boolean {
  if (!extraction || typeof extraction !== 'object') return false;
  const e = extraction as Record<string, unknown>;
  const sig = e.signature;
  if (sig && typeof sig === 'object' && 'signature_present' in (sig as object)) {
    return true;
  }
  return CORE_FIELDS.some((f) => {
    const v = e[f];
    return v != null && v !== '';
  });
}

export async function extractDprWithRetries(
  pdfBuffer: Buffer,
  opts: {
    fileName?: string;
    source?: string;
    maxAttempts?: number;
    attemptTimeoutMs?: number;
  } = {}
): Promise<ExtractDprResult> {
  const maxAttempts = opts.maxAttempts ?? OCR_MAX_ATTEMPTS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? OCR_ATTEMPT_TIMEOUT_MS;
  const source = opts.source ?? 'analysis';
  const fileName = opts.fileName || 'dpr.pdf';

  const ocrLog: OcrAttemptLog[] = [];
  let lastExtraction: Record<string, unknown> = {};
  let ocrAttemptCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = OCR_RETRY_DELAYS_MS[attempt - 2] ?? OCR_RETRY_DELAYS_MS[OCR_RETRY_DELAYS_MS.length - 1];
      await sleep(delay);
    }

    ocrAttemptCount += 1;
    const started = Date.now();
    const at = new Date().toISOString();

    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
        fileName
      );

      const aiRes = await fetch(`${AI_SERVICE_URL}/extract/dpr`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });

      if (!aiRes.ok) {
        const body = (await aiRes.text()).slice(0, 300);
        ocrLog.push({
          attempt,
          at,
          ok: false,
          error: `AI /extract/dpr HTTP ${aiRes.status}: ${body}`,
          durationMs: Date.now() - started,
          fieldCount: 0,
          hadSignature: false,
          source,
          httpStatus: aiRes.status,
        });
        continue;
      }

      const extraction = (await aiRes.json()) as Record<string, unknown>;
      lastExtraction = extraction ?? {};
      const fieldCount = countPopulatedFields(lastExtraction);
      const hadSignature = Boolean(
        lastExtraction.signature &&
          typeof lastExtraction.signature === 'object' &&
          'signature_present' in (lastExtraction.signature as object)
      );
      const usable = isUsableExtraction(lastExtraction);

      ocrLog.push({
        attempt,
        at,
        ok: usable,
        error: usable
          ? null
          : 'OCR returned empty/unusable extraction (no core fields and no signature object)',
        durationMs: Date.now() - started,
        fieldCount,
        hadSignature,
        source,
        httpStatus: 200,
      });

      if (usable) {
        return {
          extraction: lastExtraction,
          ocrLog,
          ocrAttemptCount,
          usable: true,
        };
      }
      // Empty result — fall through to retry.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ocrLog.push({
        attempt,
        at,
        ok: false,
        error: msg,
        durationMs: Date.now() - started,
        fieldCount: 0,
        hadSignature: false,
        source,
        httpStatus: null,
      });
    }
  }

  return {
    extraction: lastExtraction,
    ocrLog,
    ocrAttemptCount,
    usable: isUsableExtraction(lastExtraction),
  };
}
