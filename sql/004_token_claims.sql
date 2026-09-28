-- Runs against the "apis" database. Records the per-token identity claims
-- (userId + name, embedded in the JWT at /auth/token time) alongside each
-- stored analysis, for audit — distinct from client_username (the partner
-- login itself).
ALTER TABLE nm_response ADD COLUMN token_claims JSONB;
