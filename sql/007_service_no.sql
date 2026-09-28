-- Runs against the "apis" database. Nivesh Mitra's payment-complete signal
-- (spec §4.4) may include a ServiceNo identifying the payment service
-- request. Stored per application (on the latest nm_response row) so we can
-- return it from GET/POST /v1/payment-status.
ALTER TABLE nm_response ADD COLUMN IF NOT EXISTS service_no VARCHAR(255);
