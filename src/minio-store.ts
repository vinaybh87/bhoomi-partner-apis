// S3-compatible document store (MinIO). We pull NM DPRs once, persist bytes
// here, keep objectKey + presigned URL on nm_response.documents, and re-read
// from MinIO for OCR retries / payment re-extract so we never depend on
// Nivesh Mitra's self-signed or expiring document links.
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';

export interface StoredDocument {
  docType: string;
  fileName: string;
  /** Original NM / partner URL (audit only). */
  sourceUrl: string;
  /** Presigned GET URL (may expire — prefer objectKey for re-fetch). */
  url: string;
  objectKey: string;
  storage: 'minio';
  sha256: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

let client: S3Client | null = null;
let bucketReady = false;

export function isMinioEnabled(): boolean {
  // On by default; set MINIO_ENABLED=false to skip uploads (analysis still works).
  return (process.env.MINIO_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function getClient(): S3Client {
  if (client) return client;
  const endpoint = process.env.MINIO_ENDPOINT || 'http://127.0.0.1:9100';
  const accessKey = process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || 'bhoomi';
  const secretKey = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || 'bhoomiMinioChangeMe';
  const region = process.env.MINIO_REGION || 'us-east-1';

  client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });
  return client;
}

function bucketName(): string {
  return process.env.MINIO_BUCKET || 'bhoomi-nm-docs';
}

/** Default presign TTL: 7 days (seconds). */
function presignExpiresSec(): number {
  const n = Number(process.env.MINIO_PRESIGN_EXPIRES_SEC || 7 * 24 * 3600);
  return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 3600;
}

export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const s3 = getClient();
  const Bucket = bucketName();
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket }));
    } catch (err) {
      // Race: another process created it.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BucketAlreadyOwnedByYou') && !msg.includes('BucketAlreadyExists')) {
        throw err;
      }
    }
  }
  bucketReady = true;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file.bin';
}

export function buildObjectKey(opts: {
  applicationId: string;
  analysisId: string;
  docType: string;
  fileName?: string;
}): string {
  const ext = (opts.fileName || '').includes('.')
    ? opts.fileName!.slice(opts.fileName!.lastIndexOf('.'))
    : '.bin';
  const base = safeName(opts.fileName || `${opts.docType}${ext}`);
  return [
    'nm-apps',
    safeName(opts.applicationId),
    safeName(opts.analysisId),
    `${opts.docType.toUpperCase()}-${base}`,
  ].join('/');
}

export async function uploadBuffer(opts: {
  objectKey: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<{ sha256: string; sizeBytes: number; contentType: string }> {
  await ensureBucket();
  const contentType = opts.contentType || 'application/octet-stream';
  const sha256 = createHash('sha256').update(opts.buffer).digest('hex');
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: opts.objectKey,
      Body: opts.buffer,
      ContentType: contentType,
      Metadata: { sha256 },
    })
  );
  return { sha256, sizeBytes: opts.buffer.length, contentType };
}

export async function presignGetUrl(objectKey: string, expiresIn = presignExpiresSec()): Promise<string> {
  await ensureBucket();
  const cmd = new GetObjectCommand({ Bucket: bucketName(), Key: objectKey });
  return getSignedUrl(getClient(), cmd, { expiresIn });
}

export async function getObjectBuffer(objectKey: string): Promise<Buffer> {
  await ensureBucket();
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: bucketName(), Key: objectKey })
  );
  const body = res.Body;
  if (!body) throw new Error(`MinIO empty body for key ${objectKey}`);
  // AWS SDK v3 Body is a Readable / Blob-like
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function storeDocument(opts: {
  applicationId: string;
  analysisId: string;
  docType: string;
  fileName?: string;
  sourceUrl: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<StoredDocument> {
  if (!isMinioEnabled()) {
    throw new Error('MinIO is disabled (MINIO_ENABLED=false)');
  }
  const objectKey = buildObjectKey({
    applicationId: opts.applicationId,
    analysisId: opts.analysisId,
    docType: opts.docType,
    fileName: opts.fileName,
  });
  const meta = await uploadBuffer({
    objectKey,
    buffer: opts.buffer,
    contentType: opts.contentType
      || (opts.fileName?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
  });
  const url = await presignGetUrl(objectKey);
  return {
    docType: opts.docType.toUpperCase(),
    fileName: opts.fileName || `${opts.docType}.bin`,
    sourceUrl: opts.sourceUrl,
    url,
    objectKey,
    storage: 'minio',
    sha256: meta.sha256,
    contentType: meta.contentType,
    sizeBytes: meta.sizeBytes,
    uploadedAt: new Date().toISOString(),
  };
}

/** Load bytes preferring MinIO objectKey, then fall back to URL. */
export async function loadDocumentBytes(doc: {
  objectKey?: string;
  url?: string;
  storage?: string;
}): Promise<Buffer> {
  if (doc.objectKey && (doc.storage === 'minio' || isMinioEnabled())) {
    try {
      return await getObjectBuffer(doc.objectKey);
    } catch (err) {
      // fall through to URL if configured
      if (!doc.url) throw err;
    }
  }
  if (!doc.url) throw new Error('Document has neither objectKey nor url');
  const { fetchDocumentBuffer } = await import('./fetch-document.js');
  return fetchDocumentBuffer(doc.url);
}
