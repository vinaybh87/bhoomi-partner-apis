// Evaluator multi-doc OCR: confirm originality/validity of supporting certificates,
// then merge fields into OCR context used by marks (liquidity UDIN, export %, etc.).

import { loadDocumentBytes } from './minio-store.js';
import type { OCRData } from './marks.js';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8421';
const CERT_TIMEOUT_MS = 120_000;

export type CertificateExtraction = {
  document_class?: string;
  document_title?: string | null;
  issuer?: string | null;
  subject_name?: string | null;
  certificate_date?: string | null;
  udin?: string | null;
  liquidity_percent?: number | null;
  export_turnover_percent?: number | null;
  net_worth_crore?: number | null;
  turnover_crore?: number | null;
  appears_original?: boolean;
  has_official_markers?: boolean;
  is_complete?: boolean;
  valid?: boolean;
  confidence?: string;
  notes?: string | null;
};

export type DocEvidenceRow = {
  docType: string;
  fileName: string;
  documentClass: string;
  valid: boolean;
  appearsOriginal: boolean;
  hasOfficialMarkers: boolean;
  isComplete: boolean;
  issuer?: string | null;
  subjectName?: string | null;
  udin?: string | null;
  liquidityPercent?: number | null;
  exportTurnoverPercent?: number | null;
  netWorthCrore?: number | null;
  turnoverCrore?: number | null;
  notes?: string | null;
  error?: string | null;
  marksRelevant?: string[];
};

export type DocumentEvidenceResult = {
  documents: DocEvidenceRow[];
  /** Merged into DPR OCR before calcScore */
  ocrPatch: Partial<OCRData>;
  /** English summary for assessment HTML / logs */
  summary: string;
  caLiquidityVerified: boolean;
  exportCertVerified: boolean;
};

type StoredDoc = {
  docType?: string;
  url?: string;
  fileName?: string;
  objectKey?: string;
  storage?: string;
};

async function extractCertificate(pdfBuffer: Buffer, fileName: string): Promise<CertificateExtraction> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
    fileName
  );
  const res = await fetch(`${AI_SERVICE_URL}/extract/certificate`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(CERT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`AI /extract/certificate HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as CertificateExtraction;
}

function marksRelevantFor(cls: string): string[] {
  switch (cls) {
    case 'ca_liquidity':
      return ['liquidity'];
    case 'export_certificate':
      return ['export_oriented'];
    case 'financial_statement':
      return ['net_worth_turnover'];
    default:
      return [];
  }
}

function isMarkingDoc(docType: string, fileName: string): boolean {
  const t = `${docType} ${fileName}`.toLowerCase();
  if (t.includes('dpr')) return false; // DPR handled separately
  // Always OCR non-DPR for evidence; skip pure identity if desired — still OCR for inventory
  return true;
}

/**
 * OCR all non-DPR documents, verify originality/validity, and produce OCR patch for marks.
 * - Liquidity marks only if a valid CA liquidity cert has UDIN (+ %)
 * - Export marks only if a valid export certificate has export %
 * - Net worth/turnover may be filled from valid financial statements when missing on DPR
 */
export async function collectDocumentEvidence(
  documents: StoredDoc[] | null | undefined
): Promise<DocumentEvidenceResult> {
  const docs = Array.isArray(documents) ? documents : [];
  const rows: DocEvidenceRow[] = [];
  const ocrPatch: Partial<OCRData> = {};

  let caLiquidityVerified = false;
  let exportCertVerified = false;
  let bestLiquidity = 0;
  let bestExport = 0;
  let bestNw: number | null = null;
  let bestTo: number | null = null;

  const targets = docs.filter(
    (d) =>
      d.docType &&
      d.docType.toUpperCase() !== 'DPR' &&
      (d.objectKey || d.url) &&
      isMarkingDoc(d.docType, d.fileName || '')
  );

  // Limit concurrent OCR to avoid overloading AI service
  const concurrency = 2;
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const idx = i++;
      const d = targets[idx];
      const fileName = d.fileName || `${d.docType || 'doc'}.pdf`;
      try {
        const buffer = await loadDocumentBytes({
          objectKey: d.objectKey,
          url: d.url,
          storage: d.storage,
        });
        const cert = await extractCertificate(buffer, fileName);
        const cls = (cert.document_class || 'other').toLowerCase();
        const valid = Boolean(cert.valid);

        rows.push({
          docType: d.docType || 'OTHER',
          fileName,
          documentClass: cls,
          valid,
          appearsOriginal: Boolean(cert.appears_original),
          hasOfficialMarkers: Boolean(cert.has_official_markers),
          isComplete: Boolean(cert.is_complete),
          issuer: cert.issuer,
          subjectName: cert.subject_name,
          udin: cert.udin,
          liquidityPercent: cert.liquidity_percent ?? null,
          exportTurnoverPercent: cert.export_turnover_percent ?? null,
          netWorthCrore: cert.net_worth_crore ?? null,
          turnoverCrore: cert.turnover_crore ?? null,
          notes: cert.notes,
          marksRelevant: marksRelevantFor(cls),
        });

        if (valid && (cls === 'ca_liquidity' || (cert.udin && cert.liquidity_percent != null))) {
          caLiquidityVerified = true;
          if (cert.liquidity_percent != null && cert.liquidity_percent > bestLiquidity) {
            bestLiquidity = cert.liquidity_percent;
          }
          if (cert.udin) {
            ocrPatch.liquidity_udin = 'yes';
          }
        }

        if (valid && cls === 'export_certificate' && cert.export_turnover_percent != null) {
          exportCertVerified = true;
          if (cert.export_turnover_percent > bestExport) {
            bestExport = cert.export_turnover_percent;
          }
        }

        if (valid && cls === 'financial_statement') {
          if (cert.net_worth_crore != null) {
            bestNw = bestNw == null ? cert.net_worth_crore : Math.max(bestNw, cert.net_worth_crore);
          }
          if (cert.turnover_crore != null) {
            bestTo = bestTo == null ? cert.turnover_crore : Math.max(bestTo, cert.turnover_crore);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({
          docType: d.docType || 'OTHER',
          fileName,
          documentClass: 'error',
          valid: false,
          appearsOriginal: false,
          hasOfficialMarkers: false,
          isComplete: false,
          notes: msg,
          error: msg,
          marksRelevant: [],
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, () => worker()));

  // Only assign mark fields when certificate verified as original + valid
  if (caLiquidityVerified) {
    if (bestLiquidity > 0) ocrPatch.liquidity_percent = String(bestLiquidity);
    if (!ocrPatch.liquidity_udin) ocrPatch.liquidity_udin = 'yes';
  } else {
    // Do not award liquidity marks from DPR claim alone without CA cert
    ocrPatch.liquidity_udin = 'no';
    // Keep DPR liquidity_percent if any, but certification fails → 0 marks via certifiedMinimumTiers
  }

  if (exportCertVerified && bestExport > 0) {
    ocrPatch.export_turnover_percent = String(bestExport);
  } else {
    // Without a valid export certificate, do not award export marks from DPR alone
    ocrPatch.export_turnover_percent = null;
  }

  if (bestNw != null) ocrPatch.net_worth_crore = String(bestNw);
  if (bestTo != null) ocrPatch.turnover_crore = String(bestTo);

  ocrPatch.document_evidence = {
    ca_liquidity_verified: caLiquidityVerified,
    export_certificate_verified: exportCertVerified,
    documents: rows.map((r) => ({
      file: r.fileName,
      class: r.documentClass,
      valid: r.valid,
      original: r.appearsOriginal,
      marks: r.marksRelevant,
    })),
  };

  const validCount = rows.filter((r) => r.valid).length;
  const summary = [
    `Supporting documents OCR: ${rows.length} file(s), ${validCount} validated as original and complete.`,
    caLiquidityVerified
      ? `CA liquidity certificate verified (liquidity ${bestLiquidity || 'n/a'}%, UDIN present).`
      : 'No valid CA liquidity certificate with originality markers — liquidity marks not awarded.',
    exportCertVerified
      ? `Export certificate verified (export ${bestExport}%).`
      : 'No valid export certificate — export-oriented marks not awarded.',
  ].join(' ');

  return {
    documents: rows,
    ocrPatch,
    summary,
    caLiquidityVerified,
    exportCertVerified,
  };
}

export function mergeOcrWithEvidence(base: OCRData, patch: Partial<OCRData>): OCRData {
  return { ...base, ...patch };
}
