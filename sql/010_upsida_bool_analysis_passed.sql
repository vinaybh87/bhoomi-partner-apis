-- UPSIDA send flag on evaluation_check (true only after successful SaveAssessment).
ALTER TABLE evaluation_check
  ADD COLUMN IF NOT EXISTS upsida BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN evaluation_check.upsida IS
  'True when SaveAssessment was successfully sent to UPSIDA for this evaluation run';

-- Analysis API outcome flags on nm_response (Track A /v1/analysis).
-- ocr_attempt_count + ocr_log already track per-attempt detail (see 009).
ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS analysis_passed BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN nm_response.analysis_passed IS
  'True when /v1/analysis completed successfully (after up to 3 attempts); false if failed after retries';
