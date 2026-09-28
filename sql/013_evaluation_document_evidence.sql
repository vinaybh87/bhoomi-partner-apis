-- Optional: document OCR evidence is stored inside evaluation_check.evaluation JSONB
-- under key documentEvidence (no schema change required for JSONB).
-- This migration documents the contract and adds a helper column if useful for queries.

ALTER TABLE evaluation_check
  ADD COLUMN IF NOT EXISTS document_evidence JSONB;

COMMENT ON COLUMN evaluation_check.document_evidence IS
  'Multi-doc OCR results: originality/validity per file + flags for cert-backed marks (liquidity, export)';
