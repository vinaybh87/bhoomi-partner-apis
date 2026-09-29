// Investor Track A validation (Investor & Evaluator Assessment Criteria).
// JSON keys stay stable for partners; stage/label are English for UI display.
import { bhoomiPool } from './db.js';

export interface CheckFlag {
  passed: boolean;
  note: string;
  /** English stage name for UI (never snake_case). */
  stage: string;
  /** English validation label for UI. */
  label: string;
}

/** Machine keys (JSON) + display metadata. Matches Track A investor stages. */
export interface ApplicationChecks {
  form_dpr_mismatch: CheckFlag;
  /** Kept for backward compatibility; also folded into form_dpr_mismatch note. */
  land_value_vs_investment: CheckFlag;
  dpr_completeness: CheckFlag;
  document_correctness: CheckFlag;
  signature_check: CheckFlag;
}

/**
 * Investor check row for API + HTML.
 * All fields are human-readable English (no snake_case keys in the payload).
 */
export interface InvestorStageRow {
  number: number;
  /** e.g. "FORM VS DPR" */
  stage: string;
  /** e.g. "Form vs DPR Comparison" — what was checked */
  check: string;
  /** @deprecated use `check` — kept during transition */
  label: string;
  passed: boolean | null;
  /** "Passed" | "Flagged" | "Pending" */
  status: 'Passed' | 'Flagged' | 'Pending';
  /** Human-readable remarks */
  remarks: string;
  /** @deprecated use `remarks` */
  note: string;
}

export interface DprExtraction {
  company_name?: string | null;
  promoter_name?: string | null;
  proposed_activity?: string | null;
  land_required_sqm?: number | string | null;
  land_cost_lacs?: number | string | null;
  total_project_cost_lacs?: number | string | null;
  land_and_building_lacs?: number | string | null;
  plant_and_machinery_lacs?: number | string | null;
  total_employees?: number | string | null;
  signature?: { signature_present: boolean; page_number: number | null; confidence: string; notes: string } | null;
  [key: string]: unknown;
}

export interface NmApplication {
  username?: string;
  district?: string;
  industrialArea?: string;
  plotCategory?: string;
  landAreaSqm?: number;
  proposedInvestmentINR?: number;
  proposedLandInvestmentINR?: number;
  proposedBuildingInvestmentINR?: number;
  proposedEmployment?: number;
  sector?: string;
  formData?: Record<string, unknown>;
}

const MISMATCH_TOLERANCE = 0.10;

const STAGES = {
  formDpr: { stage: 'FORM VS DPR', label: 'Form vs DPR Comparison' },
  land: { stage: 'FORM VS DPR', label: 'Capital Investment vs Land Cost' },
  dpr: { stage: 'DPR Verification', label: 'DPR Completeness' },
  docs: { stage: 'Document Verification', label: 'Uploaded Document Verification' },
  sig: { stage: 'Signature Verification', label: 'Signature Check' },
  external: { stage: 'External Validation', label: 'MCA & GST Verification' },
} as const;

const REQUIRED_DPR_FIELDS: Array<{ key: keyof DprExtraction; label: string }> = [
  { key: 'company_name', label: 'Company Name' },
  { key: 'promoter_name', label: 'Promoter Details' },
  { key: 'proposed_activity', label: 'Business / Industrial Activity' },
  { key: 'total_project_cost_lacs', label: 'Total Project Cost' },
  { key: 'land_required_sqm', label: 'Land Area' },
  { key: 'total_employees', label: 'Employment Details' },
];

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function mismatch(a: number, b: number): boolean {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom > MISMATCH_TOLERANCE;
}

function flag(
  meta: { stage: string; label: string },
  passed: boolean,
  note: string
): CheckFlag {
  return { passed, note, stage: meta.stage, label: meta.label };
}

// Step 1: form amounts vs DPR (English remarks for UI).
function checkFormVsDpr(app: NmApplication, ocr: DprExtraction): CheckFlag {
  const mismatches: string[] = [];
  const skipped: string[] = [];

  const investmentLacs = app.proposedInvestmentINR != null ? app.proposedInvestmentINR / 100_000 : null;
  const dprInvestmentLacs = num(ocr.total_project_cost_lacs);
  if (investmentLacs != null && dprInvestmentLacs != null) {
    if (mismatch(investmentLacs, dprInvestmentLacs)) {
      mismatches.push(
        `DPR proposed ₹${dprInvestmentLacs.toFixed(1)} Lakh for total project cost; form has ₹${investmentLacs.toFixed(1)} Lakh.`
      );
    }
  } else {
    skipped.push('proposed investment / total project cost');
  }

  const dprLandSqm = num(ocr.land_required_sqm);
  if (app.landAreaSqm != null && dprLandSqm != null) {
    if (mismatch(app.landAreaSqm, dprLandSqm)) {
      mismatches.push(
        `DPR proposed ${dprLandSqm} sq.m for land; form has ${app.landAreaSqm} sq.m.`
      );
    }
  } else {
    skipped.push('land area');
  }

  const landInvestmentLacs = app.proposedLandInvestmentINR != null ? app.proposedLandInvestmentINR / 100_000 : null;
  const dprLandCostLacs = num(ocr.land_cost_lacs);
  if (landInvestmentLacs != null && dprLandCostLacs != null) {
    if (mismatch(landInvestmentLacs, dprLandCostLacs)) {
      mismatches.push(
        `DPR proposed ₹${dprLandCostLacs.toFixed(1)} Lakh for land cost; form has ₹${landInvestmentLacs.toFixed(1)} Lakh.`
      );
    }
  } else {
    skipped.push('land investment');
  }

  const buildingInvestmentLacs =
    app.proposedBuildingInvestmentINR != null ? app.proposedBuildingInvestmentINR / 100_000 : null;
  const dprLandAndBuildingLacs = num(ocr.land_and_building_lacs);
  if (buildingInvestmentLacs != null && dprLandAndBuildingLacs != null) {
    if (mismatch(buildingInvestmentLacs, dprLandAndBuildingLacs)) {
      mismatches.push(
        `DPR proposed ₹${dprLandAndBuildingLacs.toFixed(1)} Lakh for land and building; form has ₹${buildingInvestmentLacs.toFixed(1)} Lakh.`
      );
    }
  } else {
    skipped.push('building investment');
  }

  if (mismatches.length) {
    return flag(STAGES.formDpr, false, mismatches.join('\n'));
  }
  return flag(
    STAGES.formDpr,
    true,
    skipped.length
      ? `Form and DPR amounts match. Not compared: ${skipped.join(', ')}.`
      : 'Form and DPR amounts match.'
  );
}

// Financial validation under FORM VS DPR (PDF §2): Capital ≥ land cost.
async function checkLandValueVsInvestment(app: NmApplication, ocr: DprExtraction): Promise<CheckFlag> {
  const capitalLacs = (num(ocr.land_and_building_lacs) ?? 0) + (num(ocr.plant_and_machinery_lacs) ?? 0);

  let landCostLacs: number | null = null;
  let source = '';

  if (app.industrialArea && app.landAreaSqm) {
    const params: unknown[] = [app.industrialArea];
    let query = 'SELECT price_per_sqm FROM land_value WHERE industrial_area = $1';
    if (app.district) {
      query += ' AND district = $2';
      params.push(app.district);
    }
    query += ' LIMIT 1';

    const { rows } = await bhoomiPool.query(query, params);
    const pricePerSqm = rows[0]?.price_per_sqm ? Number(rows[0].price_per_sqm) : null;
    if (pricePerSqm != null) {
      landCostLacs = (pricePerSqm * app.landAreaSqm) / 100_000;
      source = `UPSIDA rate for ${app.industrialArea} (₹${pricePerSqm} per sq.m × ${app.landAreaSqm} sq.m)`;
    }
  }
  if (landCostLacs == null) {
    const dprLandCost = num(ocr.land_cost_lacs);
    if (dprLandCost != null) {
      landCostLacs = dprLandCost;
      source = 'DPR land cost (no official UPSIDA rate on file for this industrial area)';
    }
  }

  if (landCostLacs == null) {
    return flag(STAGES.land, true, 'No land value data available to compare capital investment against land cost.');
  }
  if (!capitalLacs) {
    return flag(STAGES.land, true, 'Capital investment figures missing from DPR — cannot compare with land cost.');
  }

  if (capitalLacs < landCostLacs) {
    return flag(
      STAGES.land,
      false,
      `Capital investment (land and building + plant and machinery: ₹${capitalLacs.toFixed(1)} Lakh) is below applicable land cost (₹${landCostLacs.toFixed(1)} Lakh; ${source}).`
    );
  }
  return flag(
    STAGES.land,
    true,
    `Capital investment (₹${capitalLacs.toFixed(1)} Lakh) covers applicable land cost (₹${landCostLacs.toFixed(1)} Lakh; ${source}).`
  );
}

function checkDprCompleteness(ocr: DprExtraction): CheckFlag {
  const missing = REQUIRED_DPR_FIELDS.filter((f) => ocr[f.key] == null || ocr[f.key] === '');
  if (missing.length) {
    return flag(
      STAGES.dpr,
      false,
      `Missing required DPR information: ${missing.map((m) => m.label).join(', ')}.`
    );
  }
  return flag(STAGES.dpr, true, 'All required DPR information is present (company, promoter, activity, project cost, land area, employment).');
}

/** Identity OCR validity result from Aadhaar / PAN extraction. */
export type IdentityValidity = {
  aadhaarUploaded: boolean;
  panUploaded: boolean;
  aadhaarValid: boolean;
  panValid: boolean;
  summary: string;
};

/**
 * Uploaded document verification:
 * - Either Aadhaar or PAN is enough (not both). The one present must pass OCR.
 * - Remarks say which ID was uploaded / validated.
 * - Other categories noted when present (DPR, CA, financial, supporting)
 */
function checkDocumentCorrectness(
  providedDocTypes: Set<string>,
  identity?: IdentityValidity | null
): CheckFlag {
  const aadhaarUploaded = identity?.aadhaarUploaded ?? providedDocTypes.has('AADHAAR');
  const panUploaded = identity?.panUploaded ?? providedDocTypes.has('PAN');

  const uploadedIds: string[] = [];
  if (aadhaarUploaded) uploadedIds.push('Aadhaar');
  if (panUploaded) uploadedIds.push('PAN');

  if (!identity) {
    if (!aadhaarUploaded && !panUploaded) {
      return flag(STAGES.docs, false, 'Document not found.');
    }
    return flag(
      STAGES.docs,
      true,
      uploadedIds.length === 1 ? `${uploadedIds[0]} found.` : 'Identity document found.'
    );
  }

  const aadhaarOk = aadhaarUploaded && identity.aadhaarValid;
  const panOk = panUploaded && identity.panValid;

  if (!aadhaarOk && !panOk) {
    return flag(STAGES.docs, false, 'Document not found.');
  }

  const validated: string[] = [];
  if (aadhaarOk) validated.push('Aadhaar');
  if (panOk) validated.push('PAN');
  return flag(
    STAGES.docs,
    true,
    validated.length === 1 ? `${validated[0]} found.` : 'Aadhaar and PAN found.'
  );
}

function checkSignaturePresence(ocr: DprExtraction): CheckFlag {
  const sig = ocr.signature;
  if (!sig) {
    return flag(STAGES.sig, false, 'Signature not found.');
  }
  if (!sig.signature_present) {
    return flag(STAGES.sig, false, 'Signature not found.');
  }
  return flag(STAGES.sig, true, 'Signature found.');
}

function combineFormAndLand(form: CheckFlag, land: CheckFlag): CheckFlag {
  const passed = form.passed && land.passed;
  const parts: string[] = [];
  if (form.note) parts.push(form.note);
  if (!land.passed && land.note) parts.push(land.note);
  return flag(STAGES.formDpr, passed, parts.join('\n') || form.note);
}

export async function runChecks(
  app: NmApplication,
  ocr: DprExtraction,
  providedDocTypes: Set<string> = new Set(),
  identity?: IdentityValidity | null
): Promise<ApplicationChecks> {
  const form = checkFormVsDpr(app, ocr);
  const land = await checkLandValueVsInvestment(app, ocr);
  return {
    form_dpr_mismatch: combineFormAndLand(form, land),
    land_value_vs_investment: land,
    dpr_completeness: checkDprCompleteness(ocr),
    document_correctness: checkDocumentCorrectness(providedDocTypes, identity),
    signature_check: checkSignaturePresence(ocr),
  };
}

export interface ThirdPartyVerification {
  mca: { status: 'NOT_INTEGRATED'; verified: null; note: string };
  gst: { status: 'NOT_INTEGRATED'; verified: null; note: string };
}

export function buildThirdPartyVerification(): ThirdPartyVerification {
  return {
    mca: {
      status: 'NOT_INTEGRATED',
      verified: null,
      note: 'MCA (Ministry of Corporate Affairs) verification is not yet integrated on this track.',
    },
    gst: {
      status: 'NOT_INTEGRATED',
      verified: null,
      note: 'GST verification is not yet integrated on this track.',
    },
  };
}

export interface PriorApplication {
  applicantId: string;
  industryType: string | null;
  landDetails: unknown;
  buildingDetails: unknown;
}

export interface ApplicantHistory {
  status: 'NOT_INTEGRATED' | 'FOUND' | 'NO_PRIOR_APPLICATION' | 'UNAVAILABLE';
  hasAppliedBefore: boolean | null;
  priorApplications: PriorApplication[];
  note: string;
}

export function buildApplicantHistory(): ApplicantHistory {
  return {
    status: 'NOT_INTEGRATED',
    hasAppliedBefore: null,
    priorApplications: [],
    note: 'Previous application history for this applicant is not yet integrated.',
  };
}

function rowFromFlag(number: number, f: CheckFlag): InvestorStageRow {
  const status: InvestorStageRow['status'] = f.passed ? 'Passed' : 'Flagged';
  return {
    number,
    stage: f.stage,
    check: f.label,
    label: f.label,
    passed: f.passed,
    status,
    remarks: f.note,
    note: f.note,
  };
}

/** Ordered English check list for API + HTML (PDF Track A). No snake_case. */
export function buildInvestorStages(
  checks: ApplicationChecks,
  thirdParty: ThirdPartyVerification
): InvestorStageRow[] {
  const externalNote = `${thirdParty.mca.note} ${thirdParty.gst.note}`.trim();
  const externalPending =
    thirdParty.mca.status === 'NOT_INTEGRATED' || thirdParty.gst.status === 'NOT_INTEGRATED';

  return [
    rowFromFlag(1, checks.form_dpr_mismatch),
    rowFromFlag(2, checks.dpr_completeness),
    rowFromFlag(3, checks.document_correctness),
    rowFromFlag(4, checks.signature_check),
    {
      number: 5,
      stage: STAGES.external.stage,
      check: STAGES.external.label,
      label: STAGES.external.label,
      passed: externalPending ? null : true,
      status: externalPending ? 'Pending' : 'Passed',
      remarks: externalNote || 'MCA and GST verification is pending.',
      note: externalNote || 'MCA and GST verification is pending.',
    },
  ];
}

/** English-only public payload for checks (no form_dpr_mismatch-style keys). */
export function buildChecksEnglishResponse(
  stages: InvestorStageRow[],
  thirdParty: ThirdPartyVerification,
  applicantHistory: ApplicantHistory
) {
  return {
    results: stages.map((s) => ({
      number: s.number,
      stage: s.stage,
      check: s.check,
      status: s.status,
      passed: s.passed,
      remarks: s.remarks,
    })),
    externalValidation: {
      MCA: {
        status: thirdParty.mca.status === 'NOT_INTEGRATED' ? 'Not integrated' : 'Integrated',
        verified: thirdParty.mca.verified,
        note: thirdParty.mca.note,
      },
      GST: {
        status: thirdParty.gst.status === 'NOT_INTEGRATED' ? 'Not integrated' : 'Integrated',
        verified: thirdParty.gst.verified,
        note: thirdParty.gst.note,
      },
    },
    applicantHistory: {
      status: applicantHistory.status === 'NOT_INTEGRATED' ? 'Not integrated' : applicantHistory.status,
      hasAppliedBefore: applicantHistory.hasAppliedBefore,
      priorApplications: applicantHistory.priorApplications,
      note: applicantHistory.note,
    },
  };
}
