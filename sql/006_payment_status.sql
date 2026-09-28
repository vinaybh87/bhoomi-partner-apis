-- Runs against the "apis" database. Nivesh Mitra's payment-complete signal
-- (spec §4.4) — a new inbound call telling us the applicant has paid, keyed
-- by application_id rather than analysis_id since payment happens after the
-- analysis result has already been returned.
ALTER TABLE nm_response ADD COLUMN payment_status BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE nm_response ADD COLUMN payment_confirmed_at TIMESTAMP;
