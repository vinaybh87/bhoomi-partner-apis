# Bhoomi Suvidha — Integration Note for Nivesh Mitra 3.0

Two endpoints: get a token, then submit an application for AI analysis.

**Base URL:** `https://bhoomi-suvidha.kenpath.ai/apis`

There are 3 APIs. Call them in this order:

1. **Get a token** — authenticate once, get back a signed JWT.
2. **Submit for analysis** — send the application + documents, get the discrepancy report back immediately (`analysisId` is returned here — you don't need to generate or already have it).
3. **Check status / re-fetch a result** — look up a previous submission later using the `analysisId` from step 2.

---

## Quick reference — curl for each API

**1. Get a token**
```bash
curl -X POST https://bhoomi-suvidha.kenpath.ai/apis/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "username": "<your-username>",
    "password": "<your-password>",
    "userId": "<applicationId-you-are-about-to-submit>",
    "name": "<applicant-name>"
  }'
```
Returns `{ "token": "...", "token_type": "Bearer", "expires_in": "24h" }`. Use that `token` in the two calls below.

**2. Submit for analysis**
```bash
curl -X POST https://bhoomi-suvidha.kenpath.ai/apis/v1/analysis \
  -H "Authorization: Bearer <token-from-step-1>" \
  -H "Content-Type: application/json" \
  -d '{
    "applicationId": "<applicationId>",
    "submissionSequence": 1,
    "applicant": {
      "entityType": "<e.g. Partnership / Private Limited Company>",
      "companyName": "<company name>",
      "cin": "<CIN>",
      "pan": "<company PAN>",
      "gstin": "<GSTIN>",
      "authorizedSignatory": { "name": "<name>", "pan": "<PAN>" }
    },
    "application": {
      "username": "<applicant name>",
      "district": "<district>",
      "industrialArea": "<industrial area>",
      "plotCategory": "<category>",
      "landAreaSqm": 0,
      "proposedInvestmentINR": 0,
      "proposedLandInvestmentINR": 0,
      "proposedBuildingInvestmentINR": 0,
      "proposedEmployment": 0,
      "sector": "<sector>",
      "formData": {}
    },
    "documents": [
      { "docType": "DPR", "fileName": "dpr.pdf", "url": "<pre-signed URL>", "sha256": "<checksum>" },
      { "docType": "AADHAAR", "fileName": "aadhaar.pdf", "url": "<pre-signed URL>", "sha256": "<checksum>" },
      { "docType": "PAN", "fileName": "pan.pdf", "url": "<pre-signed URL>", "sha256": "<checksum>" }
    ]
  }'
```
Returns the full discrepancy report **immediately** — no polling needed. Grab `analysisId` from this response if you want to look it up again later (step 3).

**3. Check status / re-fetch a result**
```bash
curl -X GET https://bhoomi-suvidha.kenpath.ai/apis/v1/analysis/<analysisId> \
  -H "Authorization: Bearer <token>"
```
Returns the identical response from step 2, for whatever `analysisId` it returned. `404` if that `analysisId` doesn't exist.

---

## How to test this, step by step (Postman or curl)

1. **Get a token.** New request: `POST https://bhoomi-suvidha.kenpath.ai/apis/auth/token`, body (raw JSON):
   ```json
   { "username": "<given to you>", "password": "<given to you>", "userId": "TEST-APP-001", "name": "Test Applicant" }
   ```
   Send it. Copy the `token` value from the response — you'll need it for every call below. (`userId` here just needs to match the `applicationId` you use in step 3 — pick any string for testing.)

2. **Host a sample DPR PDF somewhere we can fetch it from** — any URL reachable from the internet (S3, a temporary file host, whatever you have handy). Optionally compute its SHA256 checksum (`shasum -a 256 file.pdf` on Mac/Linux, `certutil -hashfile file.pdf SHA256` on Windows) — if you send it, we verify the download matches before analysing.

3. **Submit for analysis.** New request: `POST https://bhoomi-suvidha.kenpath.ai/apis/v1/analysis`
   - Header: `Authorization: Bearer <token from step 1>`
   - Header: `Content-Type: application/json`
   - Body: `applicationId` (same value as `userId` in step 1), `applicant`, `application`, and `documents` — see the field reference and full example below. At minimum `documents` needs one entry with `docType: "DPR"` and a working `url`.
   
   Send it — the response comes back **immediately** in the same call (no polling, no webhook needed for this test): `analysisId`, `checks` (pass/fail + explanation for each), plus the `thirdPartyVerification`/`applicantHistory` placeholder sections.

4. **(Optional) Re-fetch the same result later.** `GET https://bhoomi-suvidha.kenpath.ai/apis/v1/analysis/{analysisId}` with the same `Authorization` header — returns the identical response from step 3, in case you want to confirm it's retrievable independently of the original submission.

**What "success" looks like:** a `200` from step 1 with a `token`, then a `200` from step 3 with a populated `checks` object. If step 3 returns `401`, double check the `applicationId` in the body matches the `userId` you requested the token with. If it returns `502 FILE_ACCESS_ERROR`, we couldn't fetch or checksum-verify your document URL — check it's publicly reachable and the sha256 (if provided) is correct.

---

## 1. Get a token

```
POST /auth/token
Content-Type: application/json
```

**Body:**

| Field | Required | Description |
|---|---|---|
| `username` | Yes | Login we issue you (currently `admin` for testing) |
| `password` | Yes | Password we issue you (currently `P@$$w0RD` for testing) |
| `userId` | No | The `applicationId` you intend to submit with this token (see below — recommended) |
| `name` | No | Applicant's name, for our records |

If `userId` is provided, it gets embedded **inside the token itself** (as a signed claim) — the subsequent `/v1/analysis` call must use the *same* `applicationId`, or it will be rejected. This ties a token to one specific application rather than letting it be reused for arbitrary submissions. If you omit `userId`, the token works for any `applicationId`.

**Request:**
```json
{
  "username": "admin",
  "password": "P@$$w0RD",
  "userId": "NM3-2026-UP-104582",
  "name": "Sunita Bansal"
}
```

**Response (`200`):**
```json
{ "token": "<JWT>", "token_type": "Bearer", "expires_in": "24h" }
```

Save the `token` value — you'll attach it as a header on every following call:
```
Authorization: Bearer <token>
```

Tokens expire after 24 hours; call `/auth/token` again to get a fresh one.

**Errors:** `400` if username/password missing; `401` if credentials are wrong.

---

## 2. Submit an application for analysis

```
POST /v1/analysis
Authorization: Bearer <token>
Content-Type: application/json
```

### `applicant` object

| Field | Type | Notes |
|---|---|---|
| `entityType` | string | e.g. "Partnership", "Private Limited Company" |
| `companyName` | string | |
| `cin` | string | Corporate Identity Number, if applicable |
| `pan` | string | Company PAN |
| `gstin` | string | |
| `authorizedSignatory` | object `{name, pan}` | |

### `application` object

| Field | Type | What it's checked against |
|---|---|---|
| `username` | string | Applicant's name — stored, not currently used in a check |
| `district` | string | Used together with `industrialArea` to look up the official land rate |
| `industrialArea` | string | Matched against our land-value records |
| `plotCategory` | string | Stored, not currently used in a check |
| `landAreaSqm` | number | Compared against the land size stated in the DPR |
| `proposedInvestmentINR` | number | Compared against the DPR's total project cost |
| `proposedLandInvestmentINR` | number | Compared against the DPR's stated land cost |
| `proposedBuildingInvestmentINR` | number | Compared against the DPR's combined land+building figure (approximate — the DPR doesn't split building out separately) |
| `proposedEmployment` | number | Stored, not currently used in a check |
| `sector` | string | Stored, not currently used in a check |
| `formData` | object | Any additional key-value pairs from your form — stored as-is |

**All figures are in INR (rupees), not lakhs** — we convert internally.

### `documents` array

Each entry:

| Field | Required | Notes |
|---|---|---|
| `docType` | Yes | `DPR` (required, exactly one), `AADHAAR`, `PAN`, `OTHER` |
| `url` | Yes | A URL we can fetch the file from (pre-signed, ≤60 min validity recommended) |
| `sha256` | Recommended | We verify this against the downloaded file; mismatch = rejected |
| `fileName` | No | Cosmetic |

Only the `DPR` document is actually read (OCR'd and analysed). `AADHAAR`/`PAN` are just confirmed as present and fetchable — this feeds the document-completeness check but we don't extract data from them.

### Full example

```json
{
  "applicationId": "NM3-2026-UP-104582",
  "submissionSequence": 1,
  "callbackUrl": "https://niveshmitra.up.gov.in/api/bs-callback",
  "applicant": {
    "entityType": "Partnership",
    "companyName": "WEEE CARE",
    "cin": "U17303UT2020PTC015905",
    "pan": "ABCDE1234F",
    "gstin": "07AACFW9112H1Z5",
    "authorizedSignatory": { "name": "Sunita Bansal", "pan": "BXYZP9876Q" }
  },
  "application": {
    "username": "Sunita Bansal",
    "district": "AGRA",
    "industrialArea": "Kosi Kalan",
    "plotCategory": "General",
    "landAreaSqm": 2000,
    "proposedInvestmentINR": 50000000,
    "proposedLandInvestmentINR": 6700000,
    "proposedBuildingInvestmentINR": 15000000,
    "proposedEmployment": 50,
    "sector": "Manufacturing",
    "formData": { "promoterExperienceYears": 12 }
  },
  "documents": [
    { "docType": "DPR", "fileName": "dpr.pdf", "url": "<pre-signed URL>", "sha256": "<checksum>" },
    { "docType": "AADHAAR", "fileName": "aadhaar.pdf", "url": "<pre-signed URL>", "sha256": "<checksum>" },
    { "docType": "PAN", "fileName": "pan.pdf", "url": "<pre-signed URL>", "sha256": "<checksum>" }
  ]
}
```

> Note: `callbackUrl` and `submissionSequence` are accepted for forward-compatibility but not currently acted on — this version responds synchronously in the same call rather than queuing and calling you back. We can build that out later if needed.

### Response (`200`)

```json
{
  "analysisId": "BSA-xxxxxxxx",
  "applicationId": "NM3-2026-UP-104582",
  "status": "COMPLETED",
  "checks": {
    "form_dpr_mismatch":        { "passed": true|false, "note": "..." },
    "land_value_vs_investment": { "passed": true|false, "note": "..." },
    "dpr_completeness":         { "passed": true|false, "note": "..." },
    "document_correctness":     { "passed": true|false, "note": "..." },
    "signature_check":          { "passed": true|false, "note": "..." }
  },
  "thirdPartyVerification": {
    "mca": { "status": "NOT_INTEGRATED", "verified": null, "note": "MCA (Ministry of Corporate Affairs) verification is not yet integrated." },
    "gst": { "status": "NOT_INTEGRATED", "verified": null, "note": "GST verification is not yet integrated." }
  },
  "applicantHistory": {
    "status": "NOT_INTEGRATED",
    "hasAppliedBefore": null,
    "priorApplications": [],
    "note": "Prior-application history lookup for this applicant is not yet integrated."
  }
}
```

Each check's `note` explains *why* it passed or failed — e.g. the exact figures that mismatched, or which required DPR fields were missing.

`thirdPartyVerification` (MCA/GST validation) and `applicantHistory` (whether this applicant has ever applied before) are **placeholder fields** — the shape is final so you can build against it now, but the values aren't populated yet (`status: "NOT_INTEGRATED"`). We'll wire up the real checks and flip these to live data in a follow-up.

### Fetch the same result again later

```
GET /v1/analysis/{analysisId}
Authorization: Bearer <token>
```

Returns the identical response shown above. `404` if the `analysisId` doesn't exist.

---

## 4. Report payment status (and push assessment to UPSIDA)

```
POST /v1/payment-status
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

| Field | Required | Description |
|---|---|---|
| `applicationId` | Yes | Same id used for analysis / token `userId` |
| `status` | Yes | Boolean. Only `true` is persisted as paid |
| `ServiceNo` | No | UPSIDA service request number, e.g. `SER20240109/1000/1781/90585` |

**Request:**
```json
{
  "applicationId": "TEST-APP-001",
  "status": true,
  "ServiceNo": "SER20240109/1000/1781/90585"
}
```

**Response (`200`):**
```json
{
  "applicationId": "TEST-APP-001",
  "status": true,
  "paymentConfirmedAt": "2026-07-27T10:11:28.881Z",
  "ServiceNo": "SER20240109/1000/1781/90585",
  "upsidaPush": {
    "ok": true,
    "httpStatus": 200,
    "detail": {}
  }
}
```

When `status` is `true` and a `ServiceNo` is present (request body or already stored), we look up the matching evaluator application in bhoomi-suvidha (`land_applications.upsida_service_request_no`), assemble the AI marks + assessment payload, and `POST` it to UPSIDA:

```
POST {UPSIDA_API_BASE_URL}/Assessment/SaveAssessment?ServiceNo={ServiceNo}
```

`ServiceNo` is URL-encoded and sent only as a query-string parameter, as required by the UPSIDA Save Assessment API.

- Payment is always saved first. If the UPSIDA push fails (unknown ServiceNo, missing marks/AI eval, network error), the HTTP status stays **200** and `upsidaPush.ok` is `false` with an `error` string.
- `GET /v1/payment-status/{applicationId}` returns the stored payment fields only (no re-push).

---

## Errors you may see

| Status | Meaning |
|---|---|
| `400` | Missing required field, or `sha256` checksum mismatch (`error: "FILE_ACCESS_ERROR"`) |
| `401` | Missing/invalid/expired token, or the token's `userId` doesn't match this request's `applicationId` |
| `502` | Could not fetch the DPR from its URL, or our analysis pipeline failed |
