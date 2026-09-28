-- Runs against the "apis" database (same one as the "users" table).
-- Replaces the earlier "analyses" table with a fuller record: everything
-- Nivesh Mitra sent us (applicant, application, documents incl. their URLs),
-- which authenticated client submitted it, and the full JSON response we
-- sent back.
DROP TABLE IF EXISTS analyses;

CREATE TABLE nm_response (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id         VARCHAR(100) UNIQUE NOT NULL,
  application_id      VARCHAR(255) NOT NULL,
  submission_sequence INTEGER,
  client_username     VARCHAR(255),
  applicant           JSONB,
  application         JSONB,
  documents           JSONB,
  response            JSONB,
  created_at          TIMESTAMP DEFAULT NOW()
);
