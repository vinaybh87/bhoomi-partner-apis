// UPSIDA SaveAssessment HTTP client (outbound).

const UPSIDA_API_BASE_URL =
  process.env.UPSIDA_API_BASE_URL || 'https://upsidaAPI.stagingupsida.com/api';
const UPSIDA_API_TOKEN =
  process.env.UPSIDA_API_TOKEN || 'U2JpQXVjdGlvbjpTYmlAMTIz';

export type SaveAssessmentPayload = {
  applicationId: string;
  assessmentVersion: number;
  /** Self-contained assessment HTML+CSS, UTF-8 base64-encoded for the API body. */
  HTMLDetails: string;
  generatedAt: string;
  aiSuggestedScore: { value: number; scale: number; passMark: number };
  marksEvaluation: {
    total: number;
    max: number;
    passMark: number;
    result: 'AT_OR_ABOVE_PASS_MARK' | 'BELOW_PASS_MARK';
    parameters: { parameter: string; score: number; max: number; insight: string }[];
  };
  comparisons: unknown;
  flags: unknown;
  summary: unknown;
  mcaVerification?: unknown;
  historyVerification?: unknown;
};

export type UpsidaPushResult =
  | { ok: true; httpStatus: number; detail?: unknown }
  | { ok: false; error: string; httpStatus?: number; detail?: unknown };

export async function pushSaveAssessment(
  serviceNo: string,
  payload: SaveAssessmentPayload
): Promise<UpsidaPushResult> {
  const encoded = encodeURIComponent(serviceNo);
  const url = `${UPSIDA_API_BASE_URL.replace(/\/$/, '')}/Assessment/SaveAssessment/${encoded}?ServiceNo=${encoded}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSIDA_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    let detail: unknown;
    const text = await res.text();
    try {
      detail = text ? JSON.parse(text) : null;
    } catch {
      detail = text || null;
    }

    if (!res.ok) {
      console.error('[UPSIDA] SaveAssessment error:', res.status, text);
      return {
        ok: false,
        error: `SaveAssessment HTTP ${res.status}`,
        httpStatus: res.status,
        detail,
      };
    }

    return { ok: true, httpStatus: res.status, detail };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[UPSIDA] SaveAssessment failed —', msg);
    return { ok: false, error: msg };
  }
}
