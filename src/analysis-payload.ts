// CMS hardcodes /v1/analysis field names. Always emit every key; missing OCR
// values go out as empty strings / false — never omit the parameter.

const DPR_FIELDS = [
  'company_name',
  'promoter_name',
  'constitution',
  'year_of_establishment',
  'registered_address',
  'promoter_experience_years',
  'entrepreneur_category',
  'promoter_or_company_name_match',
  'proposed_activity',
  'land_required_sqm',
  'land_cost_lacs',
  'raw_material',
  'power_required_kw',
  'water_required_kld',
  'time_to_production_months',
  'existing_industrial_unit',
  'is_expansion_unit',
  'dpr_date',
  'total_project_cost_lacs',
  'land_and_building_lacs',
  'plant_and_machinery_lacs',
  'working_capital_lacs',
  'annual_turnover_lacs',
  'net_worth_crore',
  'turnover_crore',
  'liquidity_percent',
  'liquidity_udin',
  'export_turnover_percent',
  'fdi_proposal',
  'previous_3_year_turnover',
  'previous_3_year_networth',
  'total_employees',
  'direct_employment_count',
  'executive_summary',
] as const;

const AADHAAR_FIELDS = [
  'document_type',
  'aadhaar_present',
  'name',
  'aadhaar_number',
  'aadhaar_last4',
  'date_of_birth',
  'gender',
  'address',
  'valid_format',
  'usable',
  'notes',
] as const;

const PAN_FIELDS = [
  'document_type',
  'pan_present',
  'name',
  'pan_number',
  'father_name',
  'date_of_birth',
  'valid_format',
  'usable',
  'notes',
] as const;

const CHECK_SLOTS = [
  { number: 1, stage: 'FORM VS DPR', check: 'Form vs DPR Comparison' },
  { number: 2, stage: 'DPR Verification', check: 'DPR Completeness' },
  { number: 3, stage: 'Document Verification', check: 'Uploaded Document Verification' },
  { number: 4, stage: 'Signature Verification', check: 'Signature Check' },
  { number: 5, stage: 'External Validation', check: 'MCA & GST Verification' },
] as const;

function emptyVal(v: unknown): string | boolean | number {
  if (v == null) return '';
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length ? v.join(', ') : '';
  const s = String(v).trim();
  return s;
}

function pickFields(raw: unknown, keys: readonly string[], defaults?: Record<string, unknown>): Record<string, unknown> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const def = defaults?.[k];
    out[k] = src[k] == null ? (def !== undefined ? def : '') : emptyVal(src[k]);
  }
  return out;
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '';
  return String(v).trim();
}

/** CMS System.Text.Json GetString() — never null, never omitted. */
function asCmsString(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

export function completeExtraction(raw: unknown): Record<string, string> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const k of DPR_FIELDS) out[k] = asString(src[k]);
  const sig = src.signature && typeof src.signature === 'object' ? (src.signature as Record<string, unknown>) : {};
  // Flatten — CMS models extraction as string fields, a nested object blows their parse.
  out.signature_present = sig.signature_present ? 'yes' : 'no';
  out.signature_page = sig.page_number == null ? '' : String(sig.page_number);
  out.signature_confidence = asString(sig.confidence);
  out.signature_notes = asString(sig.notes);
  return out;
}

export function completeIdentity(raw: unknown): {
  aadhaar: Record<string, unknown>;
  pan: Record<string, unknown>;
  aadhaarValid: boolean;
  panValid: boolean;
  summary: string;
  aadhaarLast4: string;
  panNumber: string;
  aadhaarName: string;
  panName: string;
} {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const aadhaar = pickFields(src.aadhaar, AADHAAR_FIELDS, { document_type: 'aadhaar', aadhaar_present: false, valid_format: false, usable: false });
  const pan = pickFields(src.pan, PAN_FIELDS, { document_type: 'pan', pan_present: false, valid_format: false, usable: false });
  return {
    aadhaar,
    pan,
    aadhaarValid: Boolean(src.aadhaarValid),
    panValid: Boolean(src.panValid),
    summary: src.summary == null ? '' : String(src.summary),
    aadhaarLast4: src.aadhaarLast4 == null ? String(aadhaar.aadhaar_last4 || '') : String(src.aadhaarLast4),
    panNumber: src.panNumber == null ? String(pan.pan_number || '') : String(src.panNumber),
    aadhaarName: src.aadhaarName == null ? String(aadhaar.name || '') : String(src.aadhaarName),
    panName: src.panName == null ? String(pan.name || '') : String(src.panName),
  };
}

export function completeChecks(raw: unknown): Array<{
  number: number;
  stage: string;
  check: string;
  status: string;
  passed: boolean | null;
  remarks: string;
}> {
  const incoming = Array.isArray(raw) ? raw : [];
  const byNum = new Map<number, Record<string, unknown>>();
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.number === 'number') byNum.set(row.number, row);
    if (typeof row.check === 'string') byName.set(row.check, row);
  }
  return CHECK_SLOTS.map((slot) => {
    const hit = byNum.get(slot.number) || byName.get(slot.check) || {};
    return {
      number: slot.number,
      stage: String(hit.stage || slot.stage),
      check: slot.check,
      status: hit.status == null ? (hit.passed === true ? 'Passed' : 'Flagged') : String(hit.status),
      passed: hit.passed === true,
      remarks: hit.remarks == null ? '' : String(hit.remarks),
    };
  });
}

export function completeAnalysisResponse(body: Record<string, unknown>, extraction: unknown): Record<string, unknown> {
  const extVal = (body.externalValidation && typeof body.externalValidation === 'object'
    ? body.externalValidation
    : body.thirdPartyVerification && typeof body.thirdPartyVerification === 'object'
      ? body.thirdPartyVerification
      : {}) as Record<string, unknown>;
  const mcaIn = (extVal.MCA || extVal.mca || {}) as Record<string, unknown>;
  const gstIn = (extVal.GST || extVal.gst || {}) as Record<string, unknown>;
  const hist = (body.applicantHistory && typeof body.applicantHistory === 'object'
    ? body.applicantHistory
    : {}) as Record<string, unknown>;

  const statusRaw = asCmsString(body.status);
  const status =
    statusRaw.toLowerCase() === 'completed' || body.analysisPassed === true
      ? 'Completed'
      : statusRaw.toLowerCase() === 'failed' || body.analysisPassed === false
        ? 'Failed'
        : statusRaw || 'Failed';

  const englishChecks = Array.isArray(body.checkResults)
    ? body.checkResults
    : Array.isArray(body.checks)
      ? body.checks
      : [];

  return {
    // CMS C# reads these with GetProperty(...).GetString() — always strings.
    analysisId: asCmsString(body.analysisId),
    applicationId: asCmsString(body.applicationId),
    status,
    html: asCmsString(body.html),
    analysisPassed: body.analysisPassed === true,
    checks: completeChecks(englishChecks),
    externalValidation: {
      MCA: {
        status: mcaIn.status == null || String(mcaIn.status).includes('NOT_INTEGRATED')
          ? 'Not integrated'
          : String(mcaIn.status),
        verified: typeof mcaIn.verified === 'boolean' ? mcaIn.verified : false,
        note: mcaIn.note == null ? '' : String(mcaIn.note),
      },
      GST: {
        status: gstIn.status == null || String(gstIn.status).includes('NOT_INTEGRATED')
          ? 'Not integrated'
          : String(gstIn.status),
        verified: typeof gstIn.verified === 'boolean' ? gstIn.verified : false,
        note: gstIn.note == null ? '' : String(gstIn.note),
      },
    },
    applicantHistory: {
      status:
        !hist.status || String(hist.status).includes('NOT_INTEGRATED')
          ? 'Not integrated'
          : String(hist.status),
      hasAppliedBefore: typeof hist.hasAppliedBefore === 'boolean' ? hist.hasAppliedBefore : false,
      priorApplications: Array.isArray(hist.priorApplications) ? hist.priorApplications : [],
      note: hist.note == null ? '' : String(hist.note),
    },
    identityExtraction: completeIdentity(body.identityExtraction),
    extraction: completeExtraction(extraction ?? body.extraction),
  };
}
