-- Ops alerts: analysis/payment retries and failures (Slack + DB audit).
CREATE TABLE IF NOT EXISTS alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            VARCHAR(64) NOT NULL,
  severity        VARCHAR(16) NOT NULL DEFAULT 'warning',
  application_id  VARCHAR(255),
  analysis_id     VARCHAR(100),
  service_no      VARCHAR(255),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  passed          BOOLEAN,
  summary         TEXT NOT NULL,
  explanation     TEXT,
  logs            JSONB NOT NULL DEFAULT '[]'::jsonb,
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,
  slack_sent      BOOLEAN NOT NULL DEFAULT false,
  slack_ts        VARCHAR(64),
  slack_error     TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_application_id_idx ON alerts (application_id);
CREATE INDEX IF NOT EXISTS alerts_kind_idx ON alerts (kind);

COMMENT ON TABLE alerts IS
  'Stored ops alerts for analysis/payment failures and multi-attempt retries; mirrored to Slack when configured';
