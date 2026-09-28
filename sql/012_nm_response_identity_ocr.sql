-- Store OCR-extracted Aadhaar / PAN for investor analysis validity checks.
-- Full numbers live in DB for matching/duplicates; API responses should mask Aadhaar.

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_aadhaar_number VARCHAR(32);

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_aadhaar_last4 VARCHAR(4);

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_aadhaar_name VARCHAR(255);

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_pan_number VARCHAR(16);

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_pan_name VARCHAR(255);

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS identity_extraction JSONB;

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_aadhaar_valid BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE nm_response
  ADD COLUMN IF NOT EXISTS ocr_pan_valid BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS nm_response_ocr_pan_number_idx
  ON nm_response (ocr_pan_number)
  WHERE ocr_pan_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS nm_response_ocr_aadhaar_last4_idx
  ON nm_response (ocr_aadhaar_last4)
  WHERE ocr_aadhaar_last4 IS NOT NULL;

COMMENT ON COLUMN nm_response.ocr_aadhaar_number IS
  'Aadhaar number from identity OCR (may be full 12 digits or masked form)';
COMMENT ON COLUMN nm_response.ocr_pan_number IS
  'PAN number from identity OCR (normalized ABCDE1234F)';
COMMENT ON COLUMN nm_response.identity_extraction IS
  'Full identity OCR payload (aadhaar + pan objects + validity flags)';
