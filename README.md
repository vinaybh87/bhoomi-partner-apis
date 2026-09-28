# Bhoomi Suvidha — Partner APIs

Lightweight standalone service for external partners (Nivesh Mitra, etc.):
issues JWTs from a username/password, and serves AI-analysed flags per investor.

## Endpoints

### `POST /auth/token`
```json
{ "username": "nivesh-mitra", "password": "..." }
```
→ `{ "token": "<JWT, RS256>", "token_type": "Bearer", "expires_in": "24h" }`

Signed with `keys/private.pem`. We keep the private key; the token itself is
what gets handed to the partner to attach as `Authorization: Bearer <token>`
on every subsequent call.

### `GET /flags/:userId`
Requires `Authorization: Bearer <token>` from `/auth/token`.

Returns the most recent apply-wizard submission's checks + AI Assisted
Assessment for that investor (`new_form.user_id`, bhoomi-suvidha's
`investor_users.id`):
```json
{
  "user_id": "...",
  "submission_id": "...",
  "reference_no": "NM-...",
  "checks": { "form_dpr_mismatch": {...}, "dpr_completeness": {...}, ... },
  "ai_evaluation": { "comparisons": [...], "flags": [...], "summary": {...} },
  "extracted_info": { ...DPR OCR fields... },
  "applied_at": "..."
}
```
404 if that user id has no `new_form` submission yet.

## Setup

```bash
npm install
cp .env.example .env   # point DATABASE_URL at bhoomi-suvidha's postgres
psql "$DATABASE_URL" -f sql/001_init.sql   # creates api_clients table
npm run seed-client -- <username> <password> ["Display name"]
npm run dev
```

## Keys

`keys/private.pem` / `keys/public.pem` are a dedicated RS256 keypair for this
service (not the same as bhoomi-suvidha's `keys/nm-*.pem` mock-testing keys).
The private key is gitignored — regenerate with:
```bash
openssl genrsa -out /tmp/p1.pem 2048
openssl pkcs8 -topk8 -nocrypt -in /tmp/p1.pem -out keys/private.pem
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
```
