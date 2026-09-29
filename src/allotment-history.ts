import type { ApplicantHistory, PriorApplication } from './checks.js';

const SEARCH_URL = process.env.UPSIDA_ALLOTMENT_SEARCH_URL
  || 'https://webservices.onlineupsidc.com/API/GetLandAllotmentSearchDetails';
const SINGLE_DETAILS_URL = process.env.UPSIDA_ALLOTMENT_SINGLE_DETAILS_URL
  || 'https://webservices.onlineupsidc.com/api/GetLandAllotmentSingleDetails';
// The land-allotment APIs use the same UPSIDA Bearer credential as SaveAssessment.
const API_TOKEN = process.env.UPSIDA_API_TOKEN || '';
const TIMEOUT_MS = Number(process.env.UPSIDA_ALLOTMENT_TIMEOUT_MS || 10_000);
const MAX_ATTEMPTS = 3;

type ApiResult = { ok: true; data: unknown } | { ok: false };

function text(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

async function postForm(url: string, field: string, value: string): Promise<ApiResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
        },
        body: new URLSearchParams({ [field]: value }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 204) return { ok: true, data: {} };
      const raw = await res.text();
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* retry malformed upstream response */ }
      if (res.ok && Number(body.statuscode ?? 200) !== 500 && String(body.status || '').toLowerCase() !== 'error') {
        return { ok: true, data: body };
      }
    } catch { /* transient transport errors are retried */ }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  return { ok: false };
}

function serviceNumbers(body: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    for (const key of ['ServiceReqNo', 'ServiceRequestNO', 'ServiceRequestNo', 'TempServiceReqNo']) {
      const id = text(obj[key]);
      if (id) found.add(id);
    }
    Object.values(obj).forEach(visit);
  };
  visit(body);
  return [...found];
}

function projects(body: unknown): PriorApplication[] {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  return objects(data['Project Details']).flatMap((project) => {
    const applicantId = text(project.ApplicantId);
    return applicantId ? [{
      applicantId,
      industryType: text(project.IndustryType),
      landDetails: project.LandDetails ?? null,
      buildingDetails: project.BuildingDetails ?? null,
    }] : [];
  });
}

/** Live UPSIDA land-allotment history, run only after OCR extraction is complete. */
export async function lookupAllotmentHistory(values: unknown[]): Promise<ApplicantHistory> {
  const searches = [...new Set(values.map(text).filter((value): value is string => Boolean(value)))];
  if (!searches.length) {
    return { status: 'NO_PRIOR_APPLICATION', hasAppliedBefore: false, priorApplications: [], note: 'No searchable applicant details were extracted.' };
  }
  const searchResults = await Promise.all(searches.map((value) => postForm(SEARCH_URL, 'Search', value)));
  if (searchResults.some((result) => !result.ok)) {
    return { status: 'UNAVAILABLE', hasAppliedBefore: false, priorApplications: [], note: 'History lookup unavailable.' };
  }
  const successfulSearches = searchResults.filter((result): result is Extract<ApiResult, { ok: true }> => result.ok);
  const serviceNos = [...new Set(successfulSearches.flatMap((result) => serviceNumbers(result.data)))];
  if (!serviceNos.length) {
    return { status: 'NO_PRIOR_APPLICATION', hasAppliedBefore: false, priorApplications: [], note: 'No prior application found.' };
  }
  const details = await Promise.all(serviceNos.map((serviceNo) => postForm(SINGLE_DETAILS_URL, 'TempServiceReqNo', serviceNo)));
  if (details.some((result) => !result.ok)) {
    return { status: 'UNAVAILABLE', hasAppliedBefore: false, priorApplications: [], note: 'History lookup unavailable.' };
  }
  const successfulDetails = details.filter((result): result is Extract<ApiResult, { ok: true }> => result.ok);
  const seen = new Set<string>();
  const priorApplications = successfulDetails.flatMap((result) => projects(result.data)).filter((project) => {
    const key = project.applicantId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return priorApplications.length
    ? { status: 'FOUND', hasAppliedBefore: true, priorApplications, note: 'Prior land allotments found.' }
    : { status: 'NO_PRIOR_APPLICATION', hasAppliedBefore: false, priorApplications: [], note: 'No prior application found.' };
}
