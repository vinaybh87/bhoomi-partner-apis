-- Store DPR extraction on nm_response so payment-time evaluation does not
-- depend on expired Nivesh Mitra signed document URLs.
ALTER TABLE nm_response ADD COLUMN IF NOT EXISTS extraction JSONB;

-- Per payment-triggered evaluation run: SER no, AI attempt count, result JSON,
-- and error_msg only when evaluation ultimately failed.
CREATE TABLE IF NOT EXISTS evaluation_check (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  VARCHAR(255) NOT NULL,
  service_no      VARCHAR(255),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  evaluation      JSONB,
  error_msg       TEXT,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  upsida_push     JSONB,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS evaluation_check_application_id_idx
  ON evaluation_check (application_id);

CREATE INDEX IF NOT EXISTS evaluation_check_service_no_idx
  ON evaluation_check (service_no);
