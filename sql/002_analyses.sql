-- Runs against the "apis" database. Stores completed Nivesh Mitra analysis
-- results so GET /v1/analysis/:analysisId (the spec's "A2") can serve them
-- back, even though /v1/analysis (POST, "A1") in this simplified version
-- responds synchronously rather than queuing + calling back.
CREATE TABLE IF NOT EXISTS analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id       VARCHAR(100) UNIQUE NOT NULL,
  application_id    VARCHAR(255) NOT NULL,
  submission_sequence INTEGER,
  status            VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
  checks            JSONB,
  extracted_info    JSONB,
  created_at        TIMESTAMP DEFAULT NOW()
);
