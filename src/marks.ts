import rawRuleBook from './evaluator-rule-book.json' with { type: 'json' };

export interface ScoreRow {
  key: string;
  label: string;
  score: number;
  max: number;
  note: string;
  missing: boolean;
  optional?: boolean;
}

export interface ScoreResult {
  category: string;
  total: number;
  maxScore: number;
  passMark: number;
  ruleBookVersion: string;
  rows: ScoreRow[];
}

export interface OCRData {
  [key: string]: unknown;
  company_name?: string | null;
  promoter_name?: string | null;
  constitution?: string | null;
  year_of_establishment?: string | null;
  registered_address?: string | null;
  promoter_experience_years?: string | null;
  entrepreneur_category?: string | null;
  promoter_or_company_name_match?: string | null;
  proposed_activity?: string | null;
  land_required_sqm?: string | null;
  land_cost_lacs?: string | null;
  raw_material?: string | null;
  power_required_kw?: string | null;
  water_required_kld?: string | null;
  time_to_production_months?: string | null;
  existing_industrial_unit?: string | null;
  is_expansion_unit?: string | null;
  dpr_date?: string | null;
  total_project_cost_lacs?: string | null;
  land_and_building_lacs?: string | null;
  plant_and_machinery_lacs?: string | null;
  working_capital_lacs?: string | null;
  annual_turnover_lacs?: string | null;
  net_worth_crore?: string | null;
  turnover_crore?: string | null;
  liquidity_percent?: string | null;
  liquidity_udin?: string | null;
  export_turnover_percent?: string | null;
  fdi_proposal?: string | null;
  previous_3_year_turnover?: string | null;
  previous_3_year_networth?: string | null;
  total_employees?: string | null;
  direct_employment_count?: string | null;
  executive_summary?: string | null;
  signature?: unknown;
}

interface Tier {
  minimum?: number;
  maximum?: number;
  exclusive?: boolean;
  score: number;
}

interface RuleParams {
  field?: string;
  fields?: string[];
  investmentFields?: string[];
  certificationField?: string;
  certificationValue?: string;
  expectedValue?: string;
  allowedValues?: string[];
  employeesPerMark?: number;
  pointsPerYear?: number;
  minimum?: number;
  score?: number;
  tiers?: Tier[];
  requirePositive?: boolean;
  unit?: string;
  unitPrefix?: string;
  unitSuffix?: string;
  missingNote?: string;
  emptyNote?: string;
  matchedNote?: string;
  matchedNotePrefix?: string;
  unmatchedNote?: string;
  uncertifiedNote?: string;
  belowNoteSuffix?: string;
  exclusive?: boolean;
}

interface RuleDefinition {
  key: string;
  label: string;
  max: number;
  optional?: boolean;
  evaluator: string;
  params: RuleParams;
  scoring: string[];
}

interface CategoryDefinition {
  key: string;
  label: string;
  minAreaExclusive?: number;
  maxAreaInclusive?: number;
  maxScore: number;
  criteria: RuleDefinition[];
}

interface RuleBookDefinition {
  schemaVersion: number;
  ruleBookVersion: string;
  title: string;
  authority: string;
  effectiveDate: string;
  sourceDocument?: string;
  passMark: number;
  categories: CategoryDefinition[];
}

export interface ScoreContext {
  areaSqm: number;
  pricePerSqm: number;
  landCostLacs: number;
  capitalLacs: number;
  multiplier: number;
  employees: number;
}

interface CriterionResult {
  score: number;
  note: string;
  missing: boolean;
}

type RuleEvaluator = (rule: RuleDefinition, ocr: OCRData, ctx: ScoreContext) => CriterionResult;

function numeric(value: unknown): number {
  const parsed = Number.parseFloat(String(value || '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstValue(ocr: OCRData, fields: string[]): unknown {
  return fields.map(field => ocr[field]).find(Boolean);
}

function scoreMinimumTiers(value: number, tiers: Tier[]): number {
  for (const tier of tiers) {
    if (tier.minimum === undefined) continue;
    const matches = tier.exclusive ? value > tier.minimum : value >= tier.minimum;
    if (matches) return tier.score;
  }
  return 0;
}

const EVALUATORS: Record<string, RuleEvaluator> = {
  investmentRatio(rule, ocr, ctx) {
    const fields = rule.params.investmentFields || [];
    const missing = !fields.some(field => Boolean(ocr[field]));
    return {
      score: missing ? 0 : scoreMinimumTiers(ctx.multiplier, rule.params.tiers || []),
      note: missing ? rule.params.missingNote || 'Investment data missing' : `${ctx.multiplier.toFixed(1)}x land cost`,
      missing,
    };
  },

  directEmployment(rule, ocr) {
    const fields = rule.params.fields || [];
    const rawValue = firstValue(ocr, fields);
    const employees = Number.parseInt(String(rawValue || '0'), 10);
    const divisor = rule.params.employeesPerMark || 1;
    const missing = !rawValue;
    return {
      score: missing ? 0 : Math.max(0, Math.min(rule.max, Math.floor(employees / divisor))),
      note: missing ? rule.params.missingNote || 'Employment data missing' : `${employees} direct employees (1 mark per ${divisor})`,
      missing,
    };
  },

  maximumTiers(rule, ocr) {
    const field = rule.params.field || '';
    const rawValue = ocr[field];
    const value = Number.parseInt(String(rawValue || '0'), 10);
    let score = 0;
    if (!rule.params.requirePositive || value > 0) {
      score = (rule.params.tiers || []).find(tier => tier.maximum !== undefined && value <= tier.maximum)?.score || 0;
    }
    return {
      score,
      note: rawValue ? `${value} ${rule.params.unit || ''}`.trim() : rule.params.missingNote || `${field} missing`,
      missing: !rawValue,
    };
  },

  certifiedMinimumTiers(rule, ocr) {
    const field = rule.params.field || '';
    const certificationField = rule.params.certificationField || '';
    const rawValue = ocr[field];
    const certification = ocr[certificationField];
    const evidence = ocr.document_evidence as
      | { ca_liquidity_verified?: boolean }
      | undefined;
    // Prefer document OCR originality/validity over bare DPR claim
    const certFromDocs =
      certificationField === 'liquidity_udin'
        ? evidence?.ca_liquidity_verified === true && certification === rule.params.certificationValue
        : certification === rule.params.certificationValue;
    const certified = certFromDocs;
    const missing = !rawValue || !certification || !certified;
    const value = numeric(rawValue);
    return {
      score: certified ? scoreMinimumTiers(value, rule.params.tiers || []) : 0,
      note: !rawValue || !certification
        ? rule.params.missingNote || 'Required evidence missing'
        : !certified
          ? rule.params.uncertifiedNote || 'Certification missing'
          : `${value}${rule.params.unit ? ` ${rule.params.unit}` : ''}`,
      missing,
    };
  },

  yearsOfExperience(rule, ocr) {
    const field = rule.params.field || '';
    const rawValue = ocr[field];
    const years = Number.parseInt(String(rawValue || '0'), 10);
    const pointsPerYear = rule.params.pointsPerYear || 1;
    return {
      score: rawValue ? Math.max(0, Math.min(rule.max, years * pointsPerYear)) : 0,
      note: rawValue ? `${years} years (${pointsPerYear} mark${pointsPerYear === 1 ? '' : 's'} per year)` : rule.params.missingNote || 'Experience data missing',
      missing: !rawValue,
    };
  },

  exactValue(rule, ocr) {
    const raw = ocr[rule.params.field || ''];
    const expected = String(rule.params.expectedValue ?? '').toLowerCase();
    const actual = raw === true || raw === 'true' || raw === 'yes' || raw === 'Yes'
      ? 'yes'
      : String(raw ?? '').toLowerCase();
    const matched = actual === expected && actual !== '';
    return {
      // Always pair Yes with full marks and No with zero — never "Yes" + 0.
      score: matched ? rule.params.score || rule.max : 0,
      note: matched ? 'Yes' : 'No',
      missing: raw === null || raw === undefined || raw === '',
    };
  },

  minimumValue(rule, ocr) {
    const field = rule.params.field || '';
    const rawValue = ocr[field];
    const value = numeric(rawValue);
    const minimum = rule.params.minimum || 0;
    const hasRaw = rawValue !== null && rawValue !== undefined && rawValue !== '';
    const evidence = ocr.document_evidence as
      | { export_certificate_verified?: boolean }
      | undefined;
    // Export-oriented marks require a verified export certificate, not DPR claim alone
    const needsExportCert = field === 'export_turnover_percent';
    const exportOk = !needsExportCert || evidence?.export_certificate_verified === true;
    const matched =
      hasRaw &&
      exportOk &&
      (rule.params.exclusive ? value > minimum : value >= minimum);
    const unit = rule.params.unit ? ` ${rule.params.unit}` : '';
    return {
      score: matched ? rule.params.score || rule.max : 0,
      note: matched
        ? `Yes — ${value}${unit}`
        : needsExportCert && hasRaw && !exportOk
          ? 'No'
          : hasRaw
            ? `No — ${value}${unit} (below ${minimum}${unit})`
            : 'No',
      missing: !hasRaw || (needsExportCert && !exportOk),
    };
  },

  allowedValues(rule, ocr) {
    const value = String(ocr[rule.params.field || ''] || '');
    const matched = (rule.params.allowedValues || []).includes(value.toLowerCase());
    return {
      score: matched ? rule.params.score || rule.max : 0,
      note: matched
        ? `Yes — ${rule.params.matchedNotePrefix || ''}${value}`
        : 'No',
      missing: !value,
    };
  },

  anyFieldMinimum(rule, ocr) {
    const fields = rule.params.fields || [];
    const values = fields.map(field => numeric(ocr[field]));
    const highest = Math.max(0, ...values);
    const minimum = rule.params.minimum || 0;
    const matched = rule.params.exclusive ? highest > minimum : highest >= minimum;
    const missing = !fields.some(field => Boolean(ocr[field]));
    const valueNote = `${rule.params.unitPrefix || ''}${highest}${rule.params.unitSuffix || ''}`;
    return {
      score: matched ? rule.params.score || rule.max : 0,
      note: missing
        ? rule.params.missingNote || 'Required financial data missing'
        : matched
          ? valueNote
          : `${valueNote}${rule.params.belowNoteSuffix || ''}`,
      missing,
    };
  },
};

export const RULE_BOOK = rawRuleBook as unknown as RuleBookDefinition;
export const PASS_MARK = RULE_BOOK.passMark;

function validateRuleBook(ruleBook: RuleBookDefinition): void {
  if (ruleBook.schemaVersion !== 1) throw new Error(`Unsupported evaluator rule-book schema: ${ruleBook.schemaVersion}`);
  if (!ruleBook.ruleBookVersion || !ruleBook.categories.length) throw new Error('Evaluator rule book is missing version or categories');

  for (const category of ruleBook.categories) {
    const keys = new Set<string>();
    let calculatedMax = 0;
    for (const rule of category.criteria) {
      if (keys.has(rule.key)) throw new Error(`Duplicate evaluator rule key "${rule.key}" in category ${category.key}`);
      if (!EVALUATORS[rule.evaluator]) throw new Error(`Unknown evaluator function "${rule.evaluator}" for rule "${rule.key}"`);
      if (!Number.isFinite(rule.max) || rule.max < 0) throw new Error(`Invalid max score for rule "${rule.key}"`);
      for (const tier of rule.params.tiers || []) {
        if (!Number.isFinite(tier.score) || tier.score < 0 || tier.score > rule.max) {
          throw new Error(`Invalid tier score for rule "${rule.key}"`);
        }
      }
      if (rule.params.score !== undefined && (rule.params.score < 0 || rule.params.score > rule.max)) {
        throw new Error(`Configured score exceeds max for rule "${rule.key}"`);
      }
      keys.add(rule.key);
      calculatedMax += rule.max;
    }
    if (calculatedMax !== category.maxScore) {
      throw new Error(`Category ${category.key} maxScore is ${category.maxScore}, but its rules total ${calculatedMax}`);
    }
    if (ruleBook.passMark > category.maxScore) throw new Error(`Pass mark exceeds maximum score for category ${category.key}`);
  }
}

validateRuleBook(RULE_BOOK);

export interface Criterion extends RuleDefinition {
  category: string;
  compute: (ocr: OCRData, ctx: ScoreContext) => CriterionResult;
}

export const CRITERIA: Criterion[] = RULE_BOOK.categories.flatMap(category =>
  category.criteria.map(rule => ({
    ...rule,
    category: category.key,
    compute: (ocr: OCRData, ctx: ScoreContext) => EVALUATORS[rule.evaluator](rule, ocr, ctx),
  })),
);

export function getCategoryForArea(areaSqm: number): CategoryDefinition {
  const category = RULE_BOOK.categories.find(candidate =>
    (candidate.minAreaExclusive === undefined || areaSqm > candidate.minAreaExclusive)
    && (candidate.maxAreaInclusive === undefined || areaSqm <= candidate.maxAreaInclusive),
  );
  if (!category) throw new Error(`No evaluator rule-book category matches plot area ${areaSqm}`);
  return category;
}

export function calcScore(ocr: OCRData, areaSqm: number, pricePerSqm: number): ScoreResult {
  const category = getCategoryForArea(areaSqm);
  const landCostLacs = (areaSqm * pricePerSqm) / 100000;
  const investmentFields = new Set(
    category.criteria.flatMap(rule => rule.params.investmentFields || []),
  );
  const capitalLacs = [...investmentFields].reduce((sum, field) => sum + numeric(ocr[field]), 0);
  const multiplier = landCostLacs > 0 ? capitalLacs / landCostLacs : 0;
  const employees = Number.parseInt(String(firstValue(ocr, ['direct_employment_count', 'total_employees']) || '0'), 10);
  const ctx: ScoreContext = { areaSqm, pricePerSqm, landCostLacs, capitalLacs, multiplier, employees };

  const rows = category.criteria.map(rule => ({
    key: rule.key,
    label: rule.label,
    max: rule.max,
    optional: rule.optional,
    ...EVALUATORS[rule.evaluator](rule, ocr, ctx),
  }));

  return {
    category: category.key,
    total: rows.reduce((sum, row) => sum + row.score, 0),
    maxScore: category.maxScore,
    passMark: RULE_BOOK.passMark,
    ruleBookVersion: RULE_BOOK.ruleBookVersion,
    rows,
  };
}
