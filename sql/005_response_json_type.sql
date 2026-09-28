-- jsonb canonicalizes key order on storage (discards the original ordering);
-- json stores the exact input text, preserving field order for GET /v1/analysis/:id.
ALTER TABLE nm_response ALTER COLUMN response TYPE json USING response::json;
