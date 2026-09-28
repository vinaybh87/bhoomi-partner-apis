-- OCR attempt tracking for Nivesh Mitra analysis rows.
-- ocr_log: per-attempt log (timestamps, errors, outcome) for this submission.
-- ocr_attempt_count: how many times /extract/dpr was invoked for this row.

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_log JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_attempt_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN nm_response.ocr_log IS
  'Array of OCR attempt records: attempt, at, ok, error, durationMs, fieldCount, hadSignature, source';
COMMENT ON COLUMN nm_response.ocr_attempt_count IS
  'Number of times the AI /extract/dpr endpoint was called for this analysis row';
