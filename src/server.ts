import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { authPool, bhoomiPool } from './db.js';
import { getPrivateKey, getPublicKey } from './keys.js';
import {
  runChecks,
  buildThirdPartyVerification,
  buildInvestorStages,
  buildChecksEnglishResponse,
  type DprExtraction,
  type NmApplication,
} from './checks.js';
import { renderAnalysisHtml } from './render.js';
import {
  beginEvaluationCheck,
  runPaymentEvaluationAndPush,
} from './evaluate-and-push.js';
import { extractDprWithRetries, isUsableExtraction, type OcrAttemptLog } from './extract-dpr.js';
import {
  buildIdentitySummary,
  extractIdentityDocs,
  extractInvestorBatch,
  isAadhaarValid,
  isPanValid,
  type IdentityOcrResult,
} from './extract-identity.js';
import { fetchDocumentBuffer } from './fetch-document.js';
import { isMinioEnabled, storeDocument, type StoredDocument } from './minio-store.js';
import { emitAlertBackground } from './alerts.js';
import { completeAnalysisResponse } from './analysis-payload.js';
import { lookupAllotmentHistory } from './allotment-history.js';

const PORT = Number(process.env.PORT || 8010);
const JWT_ISSUER = process.env.JWT_ISSUER || 'bhoomi-suvidha-partner-apis';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

const app = express();
app.use(express.json());

// POST /auth/token — partner logs in with a username/password we issued them
// out of band, gets back a JWT signed with our private key. They attach this
// as `Authorization: Bearer <token>` on every subsequent call. We keep the
// private key ourselves; nothing about our signing key ever leaves this
// service — verification of the *same* key pair is also done here.
//
// Optional userId + name: if the caller is requesting this token on behalf of
// a specific application/user, those get embedded as signed claims in the
// token itself (not just left as unverified body fields on /v1/analysis) —
// requireAuth below extracts them from the verified token, and /v1/analysis
// checks the request body's applicationId actually matches the token's
// userId, so a caller can't swap in a different applicationId than what they
// were issued a token for.
app.post('/auth/token', async (req, res) => {
  const { username, password, userId, name } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const { rows } = await authPool.query(
    'SELECT username, password_hash FROM users WHERE username = $1',
    [username]
  );
  const client = rows[0];
  if (!client || !(await bcrypt.compare(password, client.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const privateKey = await getPrivateKey();
  const claims: Record<string, unknown> = {};
  if (userId) claims.userId = userId;
  if (name) claims.name = name;

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(client.username)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(privateKey);

  res.json({ token, token_type: 'Bearer', expires_in: JWT_EXPIRES_IN });
});

type AuthedRequest = express.Request & { client?: string; tokenUserId?: string; tokenName?: string };

// Verifies the Authorization: Bearer <token> header against our own public
// key (paired with the private key /auth/token signs with above).
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authorization: Bearer <token> required' });

  try {
    const publicKey = await getPublicKey();
    const { payload } = await jwtVerify(token, publicKey, { issuer: JWT_ISSUER });
    const authedReq = req as AuthedRequest;
    authedReq.client = payload.sub;
    if (typeof payload.userId === 'string') authedReq.tokenUserId = payload.userId;
    if (typeof payload.name === 'string') authedReq.tokenName = payload.name;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /flags/:userId — the AI-analysed checks + AI Assisted Assessment for an
// investor's most recent apply-wizard submission (new_form.user_id).
app.get('/flags/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;

  const { rows } = await bhoomiPool.query(
    `SELECT id, reference_no, checks, ai_evaluation, extracted_info, applied_at
     FROM new_form
     WHERE user_id = $1
     ORDER BY applied_at DESC
     LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'No submission found for this user id' });

  res.json({
    user_id: userId,
    submission_id: row.id,
    reference_no: row.reference_no,
    checks: row.checks,
    ai_evaluation: row.ai_evaluation,
    extracted_info: row.extracted_info,
    applied_at: row.applied_at,
  });
});

// POST /v1/analysis — spec's "A1" (NiveshMitra-3.0-Team_Integration-Spec.pdf
// §4.1). Field names match the spec exactly (applicationId, submissionSequence,
// callbackUrl, applicant, application, documents[] with docType/url/sha256).
// Simplified to a synchronous request/response (per your description) rather
// than the spec's 202-Accepted + queued-job + outbound-webhook-callback +
// polling pattern — this responds with the completed status/flags directly
// in the same call. GET /v1/analysis/:analysisId (below, the spec's "A2")
// still works afterwards since the result is persisted.
app.post('/v1/analysis', requireAuth, async (req, res) => {
  const { client: clientUsername, tokenUserId, tokenName } = req as AuthedRequest;
  const { applicationId, submissionSequence, applicant, application, documents } = req.body ?? {} as {
    applicationId?: string;
    submissionSequence?: number;
    applicant?: unknown;
    application?: NmApplication;
    documents?: Array<{ docType: string; fileName?: string; url: string; sha256?: string }>;
  };

  if (!applicationId) {
    return res.status(400).json({ error: 'applicationId is required' });
  }

  // If the token was issued for a specific userId, the request must be for
  // that same application — prevents a valid token minted for one applicant
  // being reused to submit a different one.
  if (tokenUserId && tokenUserId !== applicationId) {
    return res.status(401).json({ error: 'Token userId does not match applicationId in request body' });
  }

  // documents[] is optional — applicant/application data alone is a valid
  // submission. Without a DPR there's simply nothing to OCR, so the checks
  // that depend on it (form_dpr_mismatch, dpr_completeness, signature_check)
  // come back with a "missing" note rather than a pass/fail verdict; this
  // falls out naturally from passing an empty DprExtraction below, no
  // special-casing needed in checks.ts.
  //
  // Nivesh Mitra real payloads often put files under application.formData
  // as DocumentList / documentList (DocumentName + Url), not documents[].
  type NmDoc = { docType: string; fileName?: string; url: string; sha256?: string };
  const docs: NmDoc[] = Array.isArray(documents)
    ? documents
        .filter((d): d is NmDoc => Boolean(d?.url && d?.docType))
        .map((d) => ({
          docType: String(d.docType).toUpperCase(),
          fileName: d.fileName,
          url: d.url,
          sha256: d.sha256,
        }))
    : [];

  function mapNmDocumentName(name: string): string | null {
    const n = name.toLowerCase();
    if (n.includes('dpr')) return 'DPR';
    if (n.includes('aadhaar') || n.includes('aadhar')) return 'AADHAAR';
    if (n.includes('pan') && !n.includes('company')) return 'PAN';
    // NM packs Aadhaar/PAN as a single identity proof — count as both for
    // document_correctness (we don't OCR identity PDFs, only presence).
    if (n.includes('identity') || n.includes('id_proof') || n.includes('idproof')) {
      return 'IDENTITY';
    }
    return null;
  }

  function collectFormDataDocumentLists(formData: unknown): Array<{ name?: string; url?: string }> {
    if (!formData || typeof formData !== 'object') return [];
    const fd = formData as Record<string, unknown>;
    const lists: unknown[] = [];
    // Live NM shape: formData.DocumentList / formData.documentList
    if (Array.isArray(fd.DocumentList)) lists.push(...fd.DocumentList);
    if (Array.isArray(fd.documentList)) lists.push(...fd.documentList);
    // Older/spec shape: formData.data[0].documentList
    const data = fd.data;
    if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
      const row = data[0] as Record<string, unknown>;
      if (Array.isArray(row.documentList)) lists.push(...row.documentList);
      if (Array.isArray(row.DocumentList)) lists.push(...row.DocumentList);
    }
    return lists.map((item) => {
      if (!item || typeof item !== 'object') return {};
      const d = item as Record<string, unknown>;
      const name = (d.DocumentName ?? d.documentName ?? d.fileName ?? d.FileName) as string | undefined;
      const url = (d.Url ?? d.url ?? d.URL) as string | undefined;
      return { name, url };
    });
  }

  // Merge NM formData attachments into docs[] when partner didn't send documents[].
  if (docs.length === 0 || !docs.some((d) => d.docType === 'DPR')) {
    for (const entry of collectFormDataDocumentLists(application?.formData)) {
      if (!entry.url || !entry.name) continue;
      const mapped = mapNmDocumentName(entry.name);
      if (!mapped) continue;
      if (mapped === 'IDENTITY') {
        // Presence-only: treat as both government ID types.
        for (const t of ['AADHAAR', 'PAN'] as const) {
          if (!docs.some((d) => d.docType === t)) {
            docs.push({ docType: t, fileName: entry.name, url: entry.url });
          }
        }
        continue;
      }
      if (!docs.some((d) => d.docType === mapped)) {
        docs.push({ docType: mapped, fileName: entry.name, url: entry.url });
      }
    }
  }

  const dprDoc = docs.find((d) => d.docType === 'DPR');
  // analysisId early so MinIO object keys are stable before we INSERT.
  const analysisId = `BSA-${randomUUID().slice(0, 8)}`;

  // Max 3 attempts for failure-prone steps in this same HTTP call (fetch DPR, OCR).
  const ANALYSIS_MAX_ATTEMPTS = 3;
  const ANALYSIS_RETRY_DELAYS_MS = [2_000, 4_000];
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Fetch + checksum-verify every submitted document (DPR, AADHAAR, PAN,
  // OTHER, ...) in parallel. DPR + Aadhaar + PAN then go to the AI service
  // for concurrent OCR; other docs are confirmed reachable/intact for
  // document_correctness.
  // After fetch, persist bytes to MinIO and replace docs[] with durable
  // objectKey + presigned URL so payment re-OCR never depends on NM links.
  const fetchedDocTypes = new Set<string>();
  const docBuffers = new Map<string, Buffer>();
  const storedDocs: StoredDocument[] = [];
  /** Combined attempt log: document fetch + OCR (success and failure). */
  let analysisLog: OcrAttemptLog[] = [];
  let analysisAttemptCount = 0;
  let extraction: DprExtraction = {};
  let analysisPassed = false;
  let hardFailDetail: string | null = null;
  let hardFailCode: 'FILE_ACCESS_ERROR' | 'ANALYSIS_FAILED' | null = null;

  async function persistStoredDoc(doc: { docType: string; fileName?: string; url: string }, buffer: Buffer) {
    if (isMinioEnabled()) {
      try {
        const stored = await storeDocument({
          applicationId,
          analysisId,
          docType: doc.docType,
          fileName: doc.fileName,
          sourceUrl: doc.url,
          buffer,
        });
        storedDocs.push(stored);
        return;
      } catch (storeErr) {
        console.error('[minio] upload failed', doc.docType, storeErr);
      }
    }
    storedDocs.push({
      docType: doc.docType,
      fileName: doc.fileName || `${doc.docType}.bin`,
      sourceUrl: doc.url,
      url: doc.url,
      objectKey: '',
      storage: 'minio',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      contentType: 'application/octet-stream',
      sizeBytes: buffer.length,
      uploadedAt: new Date().toISOString(),
    });
  }

  async function fetchDocWithRetries(
    doc: { docType: string; fileName?: string; url: string; sha256?: string },
    maxAttempts: number
  ): Promise<{ ok: boolean; buffer?: Buffer; error?: string }> {
    let lastError = 'unknown fetch error';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = ANALYSIS_RETRY_DELAYS_MS[attempt - 2] ?? ANALYSIS_RETRY_DELAYS_MS[ANALYSIS_RETRY_DELAYS_MS.length - 1];
        await sleepMs(delay);
      }
      analysisAttemptCount += 1;
      const started = Date.now();
      const at = new Date().toISOString();
      try {
        // NM document hosts often use self-signed TLS — use tolerant fetcher.
        const buffer = await fetchDocumentBuffer(doc.url);
        if (doc.sha256) {
          const actual = createHash('sha256').update(buffer).digest('hex');
          if (actual.toLowerCase() !== doc.sha256.toLowerCase()) {
            throw new Error('sha256 checksum mismatch');
          }
        }
        analysisLog.push({
          attempt: analysisAttemptCount,
          at,
          ok: true,
          error: null,
          durationMs: Date.now() - started,
          fieldCount: 0,
          hadSignature: false,
          source: `analysis:fetch:${doc.docType}`,
          httpStatus: 200,
        });
        return { ok: true, buffer };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        analysisLog.push({
          attempt: analysisAttemptCount,
          at,
          ok: false,
          error: `${doc.docType} fetch: ${lastError}`,
          durationMs: Date.now() - started,
          fieldCount: 0,
          hadSignature: false,
          source: `analysis:fetch:${doc.docType}`,
          httpStatus: null,
        });
      }
    }
    return { ok: false, error: lastError };
  }

  await Promise.all(
    docs.map(async (doc) => {
      const isDpr = doc.docType === 'DPR';
      const maxAttempts = isDpr ? ANALYSIS_MAX_ATTEMPTS : 1;
      const fetched = await fetchDocWithRetries(doc, maxAttempts);
      if (!fetched.ok || !fetched.buffer) {
        // DPR required; other docs missing only affects document_correctness.
        if (isDpr) {
          hardFailCode = 'FILE_ACCESS_ERROR';
          hardFailDetail = `DPR: ${fetched.error || 'fetch failed after retries'}`;
        }
        return;
      }

      docBuffers.set(doc.docType, fetched.buffer);
      fetchedDocTypes.add(doc.docType);
      await persistStoredDoc(doc, fetched.buffer);
    })
  );

  // Prefer MinIO-backed records for DB; fall back to original docs if none stored.
  const documentsForDb = storedDocs.length
    ? storedDocs
    : docs.map((d) => ({
        docType: d.docType,
        fileName: d.fileName,
        sourceUrl: d.url,
        url: d.url,
        objectKey: '',
        storage: 'source' as const,
      }));

  // Identity OCR (Aadhaar / PAN) — parallel with DPR when possible.
  let identityExtraction: {
    aadhaar: unknown;
    pan: unknown;
    aadhaarValid: boolean;
    panValid: boolean;
    summary: string;
  } | null = null;

  const aadhaarBuf = docBuffers.get('AADHAAR') ?? null;
  const panBuf = docBuffers.get('PAN') ?? null;
  const hasIdentity = Boolean(aadhaarBuf || panBuf);

  const runIdentityOcr = async () => {
    if (!hasIdentity) return null;
    const combined =
      aadhaarBuf && panBuf && aadhaarBuf.equals(panBuf) ? aadhaarBuf : null;
    return extractIdentityDocs({
      aadhaarBuffer: aadhaarBuf,
      panBuffer: panBuf,
      combinedBuffer: combined,
      aadhaarFileName: docs.find((d) => d.docType === 'AADHAAR')?.fileName,
      panFileName: docs.find((d) => d.docType === 'PAN')?.fileName,
      combinedFileName:
        docs.find((d) => d.docType === 'AADHAAR')?.fileName ||
        docs.find((d) => d.docType === 'PAN')?.fileName ||
        'identity.pdf',
    });
  };

  if (!hardFailCode && dprDoc) {
    const pdfBuffer = docBuffers.get('DPR');
    if (!pdfBuffer) {
      analysisLog.push({
        attempt: analysisAttemptCount || 0,
        at: new Date().toISOString(),
        ok: false,
        error: 'DPR document listed but buffer missing after fetch',
        durationMs: 0,
        fieldCount: 0,
        hadSignature: false,
        source: 'analysis',
      });
      hardFailCode = 'FILE_ACCESS_ERROR';
      hardFailDetail = 'DPR document listed but buffer missing after fetch';
      // Still try identity OCR if buffers exist
      try {
        const idRes = await runIdentityOcr();
        if (idRes) {
          identityExtraction = {
            aadhaar: idRes.aadhaar,
            pan: idRes.pan,
            aadhaarValid: idRes.aadhaarValid,
            panValid: idRes.panValid,
            summary: idRes.summary,
          };
          for (const e of idRes.identityLog) {
            analysisLog.push({
              attempt: analysisAttemptCount + e.attempt,
              at: e.at,
              ok: e.ok,
              error: e.error,
              durationMs: e.durationMs,
              fieldCount: 0,
              hadSignature: false,
              source: e.source,
              httpStatus: e.httpStatus,
            });
          }
          analysisAttemptCount += idRes.identityLog.length;
        }
      } catch (idErr) {
        console.error('[analysis] identity OCR error', idErr);
      }
    } else {
      // One AI-service call OCRs DPR + Aadhaar + PAN concurrently. Targeted
      // per-doc retries only run for whatever that first shot left unusable.
      let ocrResult: Awaited<ReturnType<typeof extractDprWithRetries>> | null = null;
      let idRes: IdentityOcrResult | null = null;
      const combined =
        aadhaarBuf && panBuf && aadhaarBuf.equals(panBuf) ? aadhaarBuf : null;

      if (hasIdentity) {
        const batch = await extractInvestorBatch({
          dprBuffer: pdfBuffer,
          dprFileName: dprDoc.fileName || 'dpr.pdf',
          aadhaarBuffer: combined ? null : aadhaarBuf,
          aadhaarFileName: docs.find((d) => d.docType === 'AADHAAR')?.fileName,
          panBuffer: combined ? null : panBuf,
          panFileName: docs.find((d) => d.docType === 'PAN')?.fileName,
          identityBuffer: combined,
          identityFileName:
            docs.find((d) => d.docType === 'AADHAAR')?.fileName ||
            docs.find((d) => d.docType === 'PAN')?.fileName ||
            'identity.pdf',
        });
        analysisAttemptCount += 1;
        analysisLog.push({
          attempt: analysisAttemptCount,
          at: new Date().toISOString(),
          ok: batch.httpStatus === 200 && !batch.error,
          error: batch.error || (Object.keys(batch.errors).length ? JSON.stringify(batch.errors) : null),
          durationMs: batch.durationMs,
          fieldCount: batch.dpr ? Object.keys(batch.dpr).length : 0,
          hadSignature: Boolean(
            batch.dpr &&
              typeof batch.dpr.signature === 'object' &&
              batch.dpr.signature &&
              'signature_present' in (batch.dpr.signature as object)
          ),
          source: 'analysis:ocr:investor',
          httpStatus: batch.httpStatus,
        });

        if (batch.httpStatus === 200 && !batch.error) {
          if (batch.dpr) {
            const usable = isUsableExtraction(batch.dpr);
            ocrResult = {
              extraction: batch.dpr,
              ocrLog: [],
              ocrAttemptCount: 0,
              usable,
            };
          }
          if (batch.aadhaar || batch.pan) {
            const aadhaarValid = isAadhaarValid(batch.aadhaar);
            const panValid = isPanValid(batch.pan);
            idRes = {
              aadhaar: batch.aadhaar,
              pan: batch.pan,
              identityLog: [],
              summary: buildIdentitySummary({
                aadhaar: batch.aadhaar,
                pan: batch.pan,
                aadhaarValid,
                panValid,
                aadhaarUploaded: Boolean(aadhaarBuf),
                panUploaded: Boolean(panBuf),
              }),
              aadhaarValid,
              panValid,
            };
          }
        }
      }

      const needDprRetry = !ocrResult || !ocrResult.usable;
      const needIdRetry =
        hasIdentity && !(idRes?.aadhaarValid || idRes?.panValid);

      if (needDprRetry || needIdRetry) {
        const [retryDpr, retryId] = await Promise.all([
          needDprRetry
            ? extractDprWithRetries(pdfBuffer, {
                fileName: dprDoc.fileName || 'dpr.pdf',
                source: 'analysis',
                maxAttempts: ANALYSIS_MAX_ATTEMPTS,
              })
            : Promise.resolve(null),
          needIdRetry
            ? runIdentityOcr().catch((err) => {
                console.error('[analysis] identity OCR error', err);
                return null;
              })
            : Promise.resolve(null),
        ]);
        if (retryDpr) ocrResult = retryDpr;
        if (retryId) idRes = retryId;
      }

      if (!ocrResult) {
        ocrResult = {
          extraction: {},
          ocrLog: [],
          ocrAttemptCount: 0,
          usable: false,
        };
      }

      extraction = ocrResult.extraction as DprExtraction;
      const ocrLogOffset = analysisAttemptCount;
      for (const entry of ocrResult.ocrLog) {
        analysisLog.push({
          ...entry,
          attempt: ocrLogOffset + entry.attempt,
          source: entry.source || 'analysis',
        });
      }
      analysisAttemptCount += ocrResult.ocrAttemptCount;

      if (idRes) {
        identityExtraction = {
          aadhaar: idRes.aadhaar,
          pan: idRes.pan,
          aadhaarValid: idRes.aadhaarValid,
          panValid: idRes.panValid,
          summary: idRes.summary,
        };
        for (const e of idRes.identityLog) {
          analysisLog.push({
            attempt: analysisAttemptCount + e.attempt,
            at: e.at,
            ok: e.ok,
            error: e.error,
            durationMs: e.durationMs,
            fieldCount: 0,
            hadSignature: false,
            source: e.source,
            httpStatus: e.httpStatus,
          });
        }
        analysisAttemptCount += idRes.identityLog.length;
      }

      const anyHttpOk = ocrResult.ocrLog.some((e) => e.httpStatus === 200);
      if (!anyHttpOk && ocrResult.ocrAttemptCount > 0) {
        const last = ocrResult.ocrLog[ocrResult.ocrLog.length - 1];
        hardFailCode = 'ANALYSIS_FAILED';
        hardFailDetail = last?.error || 'DPR OCR failed after retries';
      } else {
        analysisPassed = true;
      }
    }
  } else if (!hardFailCode && !dprDoc) {
    analysisLog.push({
      attempt: 0,
      at: new Date().toISOString(),
      ok: false,
      error: 'No DPR document in request — DPR OCR skipped',
      durationMs: 0,
      fieldCount: 0,
      hadSignature: false,
      source: 'analysis',
    });
    try {
      const idRes = await runIdentityOcr();
      if (idRes) {
        identityExtraction = {
          aadhaar: idRes.aadhaar,
          pan: idRes.pan,
          aadhaarValid: idRes.aadhaarValid,
          panValid: idRes.panValid,
          summary: idRes.summary,
        };
        for (const e of idRes.identityLog) {
          analysisLog.push({
            attempt: analysisAttemptCount + e.attempt,
            at: e.at,
            ok: e.ok,
            error: e.error,
            durationMs: e.durationMs,
            fieldCount: 0,
            hadSignature: false,
            source: e.source,
            httpStatus: e.httpStatus,
          });
        }
        analysisAttemptCount += idRes.identityLog.length;
      }
    } catch (idErr) {
      console.error('[analysis] identity OCR error', idErr);
    }
    analysisPassed = true;
  }

  // Optional: prior applications with same PAN / Aadhaar last4 (validity / history signal).
  let priorIdentityNote = '';
  try {
    const panForLookup = (() => {
      const p = identityExtraction?.pan as { pan_number?: string } | null | undefined;
      return p?.pan_number ? String(p.pan_number).replace(/\s+/g, '').toUpperCase() : null;
    })();
    const aadhaarLast4Lookup = (() => {
      const a = identityExtraction?.aadhaar as { aadhaar_last4?: string; aadhaar_number?: string } | null | undefined;
      if (a?.aadhaar_last4 && /^\d{4}$/.test(a.aadhaar_last4)) return a.aadhaar_last4;
      const digits = (a?.aadhaar_number || '').replace(/\D/g, '');
      return digits.length >= 4 ? digits.slice(-4) : null;
    })();

    if (panForLookup || aadhaarLast4Lookup) {
      const { rows: prior } = await authPool.query(
        `SELECT application_id, analysis_id, created_at, ocr_pan_number, ocr_aadhaar_last4
           FROM nm_response
          WHERE application_id <> $1
            AND (
              ($2::text IS NOT NULL AND ocr_pan_number = $2)
              OR ($3::text IS NOT NULL AND ocr_aadhaar_last4 = $3)
            )
          ORDER BY created_at DESC
          LIMIT 5`,
        [applicationId, panForLookup, aadhaarLast4Lookup]
      );
      if (prior.length) {
        const apps = [...new Set(prior.map((r: { application_id: string }) => r.application_id))].slice(0, 3);
        priorIdentityNote = ` Same identity was previously seen on application id(s): ${apps.join(', ')}.`;
      }
    }
  } catch (priorErr) {
    console.error('[analysis] prior identity lookup failed', priorErr);
  }

  const identityValidity = {
    aadhaarUploaded: Boolean(aadhaarBuf) || fetchedDocTypes.has('AADHAAR'),
    panUploaded: Boolean(panBuf) || fetchedDocTypes.has('PAN'),
    aadhaarValid: identityExtraction?.aadhaarValid ?? false,
    panValid: identityExtraction?.panValid ?? false,
    summary:
      (identityExtraction?.summary ?? 'Identity OCR was not run.') + priorIdentityNote,
  };

  // The external history calls intentionally start only after all OCR extraction
  // has completed. Their result is persisted and later used in UPSIDA HTMLDetails.
  const historyPan = (() => {
    const p = identityExtraction?.pan as { pan_number?: string } | null | undefined;
    return p?.pan_number ? String(p.pan_number).replace(/\s+/g, '').toUpperCase() : null;
  })();
  const historyApplicant = (applicant ?? {}) as {
    pan?: string | null;
    cin?: string | null;
    gstin?: string | null;
    gst?: string | null;
    companyName?: string | null;
  };
  const applicantHistory = await lookupAllotmentHistory([
    historyPan,
    historyApplicant.pan,
    historyApplicant.cin,
    historyApplicant.gstin ?? historyApplicant.gst,
    extraction?.company_name,
    historyApplicant.companyName,
  ]);

  const checks = await runChecks(application ?? {}, extraction, fetchedDocTypes, identityValidity);
  const thirdPartyVerification = buildThirdPartyVerification();
  const stages = buildInvestorStages(checks, thirdPartyVerification);
  const checksEnglish = buildChecksEnglishResponse(stages, thirdPartyVerification, applicantHistory);
  const companyName = (applicant as { companyName?: string } | undefined)?.companyName;
  const status = analysisPassed ? 'Completed' : 'Failed';
  const html = renderAnalysisHtml({
    analysisId,
    applicationId,
    companyName,
    checks,
    thirdPartyVerification,
    applicantHistory,
    status,
    stages,
  });

  // Fields to persist in DB (full numbers for validity / duplicate checks).
  type IdAadhaar = {
    name?: string | null;
    aadhaar_number?: string | null;
    aadhaar_last4?: string | null;
  };
  type IdPan = { name?: string | null; pan_number?: string | null };
  const rawAadhaar = (identityExtraction?.aadhaar ?? null) as IdAadhaar | null;
  const rawPan = (identityExtraction?.pan ?? null) as IdPan | null;

  const ocrAadhaarNumber = rawAadhaar?.aadhaar_number
    ? String(rawAadhaar.aadhaar_number).replace(/\s+/g, ' ').trim()
    : null;
  const ocrAadhaarLast4 =
    rawAadhaar?.aadhaar_last4 && /^\d{4}$/.test(String(rawAadhaar.aadhaar_last4))
      ? String(rawAadhaar.aadhaar_last4)
      : ocrAadhaarNumber
        ? (ocrAadhaarNumber.replace(/\D/g, '').slice(-4) || null)
        : null;
  const ocrAadhaarName = rawAadhaar?.name ? String(rawAadhaar.name).trim().slice(0, 255) : null;
  const ocrPanNumber = rawPan?.pan_number
    ? String(rawPan.pan_number).replace(/\s+/g, '').toUpperCase().slice(0, 16)
    : null;
  const ocrPanName = rawPan?.name ? String(rawPan.name).trim().slice(0, 255) : null;
  const ocrAadhaarValid = identityExtraction?.aadhaarValid ?? false;
  const ocrPanValid = identityExtraction?.panValid ?? false;

  // Full identity payload for DB (includes numbers).
  const identityForDb = identityExtraction
    ? {
        aadhaar: identityExtraction.aadhaar,
        pan: identityExtraction.pan,
        aadhaarValid: ocrAadhaarValid,
        panValid: ocrPanValid,
        summary: identityExtraction.summary,
        ocr_aadhaar_number: ocrAadhaarNumber,
        ocr_aadhaar_last4: ocrAadhaarLast4,
        ocr_pan_number: ocrPanNumber,
      }
    : null;

  // Mask full Aadhaar number in public response (privacy); PAN kept (standard on forms).
  const publicIdentity = identityExtraction
    ? {
        aadhaar: identityExtraction.aadhaar
          ? {
              ...(identityExtraction.aadhaar as object),
              aadhaar_number: ocrAadhaarLast4 ? `XXXX-XXXX-${ocrAadhaarLast4}` : null,
            }
          : null,
        pan: identityExtraction.pan,
        aadhaarValid: ocrAadhaarValid,
        panValid: ocrPanValid,
        summary: identityExtraction.summary,
        // Explicit fields for clients (masked Aadhaar)
        aadhaarLast4: ocrAadhaarLast4,
        panNumber: ocrPanNumber,
        aadhaarName: ocrAadhaarName,
        panName: ocrPanName,
      }
    : null;

  // Public response: English only for checks (no form_dpr_mismatch-style keys).
  // CMS hardcodes parameter names — always emit every field, empty if OCR missed it.
  const responseBody = completeAnalysisResponse(
    {
      analysisId,
      applicationId,
      status,
      analysisPassed,
      checks: checksEnglish.results,
      checkResults: checksEnglish.results,
      externalValidation: checksEnglish.externalValidation,
      applicantHistory: checksEnglish.applicantHistory,
      identityExtraction: publicIdentity,
      attemptCount: analysisAttemptCount,
      attemptLog: analysisLog,
      ocrAttemptCount: analysisAttemptCount,
      ocrLog: analysisLog,
      html,
      ...(hardFailCode
        ? {
            error: hardFailCode === 'FILE_ACCESS_ERROR' ? 'File access error' : 'Analysis failed',
            errorCode: hardFailCode,
            detail: hardFailDetail,
          }
        : {}),
    },
    extraction
  );

  // Persist OCR identity numbers for later validity / duplicate checks.
  await authPool.query(
    `INSERT INTO nm_response
       (analysis_id, application_id, submission_sequence, client_username, token_claims,
        applicant, application, documents, response, extraction, ocr_log, ocr_attempt_count,
        analysis_passed,
        ocr_aadhaar_number, ocr_aadhaar_last4, ocr_aadhaar_name,
        ocr_pan_number, ocr_pan_name, identity_extraction,
        ocr_aadhaar_valid, ocr_pan_valid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (analysis_id) DO UPDATE SET
       ocr_aadhaar_number = EXCLUDED.ocr_aadhaar_number,
       ocr_aadhaar_last4 = EXCLUDED.ocr_aadhaar_last4,
       ocr_aadhaar_name = EXCLUDED.ocr_aadhaar_name,
       ocr_pan_number = EXCLUDED.ocr_pan_number,
       ocr_pan_name = EXCLUDED.ocr_pan_name,
       identity_extraction = EXCLUDED.identity_extraction,
       ocr_aadhaar_valid = EXCLUDED.ocr_aadhaar_valid,
       ocr_pan_valid = EXCLUDED.ocr_pan_valid,
       response = EXCLUDED.response,
       extraction = EXCLUDED.extraction,
       ocr_log = EXCLUDED.ocr_log,
       ocr_attempt_count = EXCLUDED.ocr_attempt_count,
       analysis_passed = EXCLUDED.analysis_passed`,
    [
      analysisId,
      applicationId,
      submissionSequence ?? null,
      clientUsername ?? null,
      JSON.stringify({ userId: tokenUserId ?? null, name: tokenName ?? null }),
      JSON.stringify(applicant ?? null),
      JSON.stringify(application ?? null),
      JSON.stringify(documentsForDb),
      JSON.stringify({ ...responseBody, html }),
      JSON.stringify(extraction ?? null),
      JSON.stringify(analysisLog),
      analysisAttemptCount,
      analysisPassed,
      ocrAadhaarNumber,
      ocrAadhaarLast4,
      ocrAadhaarName,
      ocrPanNumber,
      ocrPanName,
      identityForDb ? JSON.stringify(identityForDb) : null,
      ocrAadhaarValid,
      ocrPanValid,
    ]
  );

  // Slack + DB: any hard fail, identity OCR miss, or a real OCR retry — not
  // every successful run (fetch increments would otherwise look like retries).
  const identityOcrFailed =
    Boolean(aadhaarBuf || panBuf) &&
    !(identityExtraction?.aadhaarValid || identityExtraction?.panValid);
  const ocrStepFailed = analysisLog.some(
    (e) =>
      e.ok === false &&
      /ocr|extract\/(dpr|aadhaar|pan|investor|identity)/i.test(String(e.source || e.error || ''))
  );
  const ocrRetriedThenOk =
    analysisPassed &&
    analysisLog.filter((e) => /ocr|extract\//i.test(String(e.source || '')) && e.ok === false).length >
      0;

  let alertKind:
    | 'analysis_failed'
    | 'file_access_error'
    | 'identity_ocr_failed'
    | 'analysis_retry'
    | null = null;
  if (hardFailCode === 'FILE_ACCESS_ERROR') alertKind = 'file_access_error';
  else if (hardFailCode || !analysisPassed) alertKind = 'analysis_failed';
  else if (identityOcrFailed) alertKind = 'identity_ocr_failed';
  else if (ocrRetriedThenOk || ocrStepFailed) alertKind = 'analysis_retry';

  if (alertKind) {
    emitAlertBackground({
      kind: alertKind,
      severity: alertKind === 'analysis_retry' ? 'warning' : 'critical',
      applicationId,
      analysisId,
      attemptCount: analysisAttemptCount,
      passed: analysisPassed && !identityOcrFailed,
      logs: analysisLog as import('./alerts.js').AlertLogEntry[],
      context: {
        hardFailCode,
        hardFailDetail,
        status,
        clientUsername: clientUsername ?? null,
        identityOcrFailed,
        aadhaarValid: identityExtraction?.aadhaarValid ?? null,
        panValid: identityExtraction?.panValid ?? null,
        identitySummary: identityExtraction?.summary ?? null,
      },
    });
  }

  if (hardFailCode) {
    return res.status(502).json({
      analysisId: String(analysisId ?? ''),
      applicationId: String(applicationId ?? ''),
      status: 'Failed',
      html: String(html || ''),
      error: hardFailCode,
      detail: hardFailDetail,
      analysisPassed: false,
      attemptCount: analysisAttemptCount,
      attemptLog: analysisLog,
      ocrAttemptCount: analysisAttemptCount,
      ocrLog: analysisLog,
    });
  }

  // Same URL, same data either way — ?format=html returns the rendered
  // report (Content-Type: text/html) instead of JSON, so there's no need for
  // a separate /html-suffixed route. Default stays JSON, matching the spec.
  if (req.query.format === 'html') {
    return res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  }
  res.json(responseBody);
});

// GET /v1/analysis/:analysisId — spec's "A2", fetches the full report.
// ?format=html returns the same stored `html` report directly as text/html
// instead of JSON (same data, just a different Content-Type on request).
app.get('/v1/analysis/:analysisId', requireAuth, async (req, res) => {
  const { rows } = await authPool.query(
    'SELECT response, extraction FROM nm_response WHERE analysis_id = $1',
    [req.params.analysisId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Unknown analysisId' });

  if (req.query.format === 'html') {
    const html = (row.response as { html?: string }).html;
    if (!html) return res.status(404).send('<p>HTML report not available for this analysisId (submitted before this feature was added).</p>');
    return res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  }
  const stored = (row.response && typeof row.response === 'object' ? row.response : {}) as Record<string, unknown>;
  res.json(completeAnalysisResponse(stored, row.extraction ?? stored.extraction));
});

// POST /v1/payment-status — Nivesh Mitra's payment-complete signal (spec
// §4.4). NM calls this once the applicant has paid, using the same Bearer
// token + applicationId pattern as /v1/analysis. Applies to the most recent
// submission on file for that applicationId. Only a `true` value is ever
// persisted — once confirmed paid, a later call can't un-set it.
// Optional ServiceNo (e.g. "SER20260417/1000/14391/175411") is stored when
// provided and returned on subsequent reads.
app.post('/v1/payment-status', requireAuth, async (req, res) => {
  const { tokenUserId } = req as AuthedRequest;
  const { applicationId, status, ServiceNo } = req.body ?? {} as {
    applicationId?: string;
    status?: boolean;
    ServiceNo?: string;
  };

  if (!applicationId || typeof status !== 'boolean') {
    return res.status(400).json({ error: 'applicationId and status (boolean) are required' });
  }
  if (tokenUserId && tokenUserId !== applicationId) {
    return res.status(401).json({ error: 'Token userId does not match applicationId in request body' });
  }

  const serviceNo =
    typeof ServiceNo === 'string' && ServiceNo.trim() ? ServiceNo.trim() : null;

  const { rows } = await authPool.query(
    'SELECT analysis_id FROM nm_response WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1',
    [applicationId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Unknown applicationId — no analysis on file for it' });

  if (status) {
    await authPool.query(
      `UPDATE nm_response
          SET payment_status = true,
              payment_confirmed_at = NOW(),
              service_no = COALESCE($2, service_no)
        WHERE analysis_id = $1`,
      [row.analysis_id, serviceNo]
    );
  } else if (serviceNo) {
    // Still allow attaching/updating ServiceNo even if status is not true yet.
    await authPool.query(
      'UPDATE nm_response SET service_no = $2 WHERE analysis_id = $1',
      [row.analysis_id, serviceNo]
    );
  }

  const { rows: updated } = await authPool.query(
    'SELECT payment_status, payment_confirmed_at, service_no FROM nm_response WHERE analysis_id = $1',
    [row.analysis_id]
  );

  const confirmedServiceNo: string | null = updated[0].service_no ?? null;

  // Payment responds immediately. Evaluation runs in the background; as soon as
  // AI is ready the result is stored and pushed to UPSIDA SaveAssessment.
  let evaluation: {
    status: 'started' | 'skipped';
    evaluationCheckId?: string;
    message: string;
  } | undefined;

  if (updated[0].payment_status === true && confirmedServiceNo) {
    try {
      const checkId = await beginEvaluationCheck(applicationId, confirmedServiceNo);
      evaluation = {
        status: 'started',
        evaluationCheckId: checkId,
        message:
          'Evaluation started. As soon as AI analysis is ready it will be sent to UPSIDA SaveAssessment. Poll GET /v1/payment-status/:applicationId for result.',
      };
      void runPaymentEvaluationAndPush({
        applicationId,
        serviceNo: confirmedServiceNo,
        checkId,
      }).catch((err) => {
        console.error('[EVAL] background pipeline unhandled —', err instanceof Error ? err.message : err);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      evaluation = {
        status: 'skipped',
        message: `Could not start evaluation: ${msg}`,
      };
    }
  }

  res.json({
    applicationId,
    status: updated[0].payment_status,
    paymentConfirmedAt: updated[0].payment_confirmed_at,
    ServiceNo: confirmedServiceNo,
    ...(evaluation ? { evaluation } : {}),
  });
});

// GET /v1/payment-status/:applicationId — payment fields + latest evaluation_check
// (so callers can see when background AI finished and whether UPSIDA was pushed).
app.get('/v1/payment-status/:applicationId', requireAuth, async (req, res) => {
  const { rows } = await authPool.query(
    'SELECT payment_status, payment_confirmed_at, service_no FROM nm_response WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.params.applicationId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Unknown applicationId — no analysis on file for it' });

  const { rows: evalRows } = await authPool.query(
    `SELECT id, service_no, attempt_count, status, error_msg, upsida_push, upsida,
            created_at, updated_at,
            (evaluation IS NOT NULL) AS has_evaluation
       FROM evaluation_check
      WHERE application_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [req.params.applicationId]
  );
  const ev = evalRows[0];

  res.json({
    applicationId: req.params.applicationId,
    status: row.payment_status,
    paymentConfirmedAt: row.payment_confirmed_at,
    ServiceNo: row.service_no,
    evaluation: ev
      ? {
          evaluationCheckId: ev.id,
          serviceNo: ev.service_no,
          status: ev.status,
          attempt_count: ev.attempt_count,
          has_evaluation: ev.has_evaluation,
          error_msg: ev.error_msg,
          upsida: ev.upsida === true,
          upsida_push: ev.upsida_push,
          createdAt: ev.created_at,
          updatedAt: ev.updated_at,
        }
      : null,
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`[apis] listening on http://0.0.0.0:${PORT}`);
});
