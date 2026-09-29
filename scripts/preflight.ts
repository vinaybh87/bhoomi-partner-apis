import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import pg from 'pg';

const required = [
  'AUTH_DATABASE_URL',
  'BHOOMI_DATABASE_URL',
  'AI_SERVICE_URL',
  'JWT_PRIVATE_KEY_PATH',
  'JWT_PUBLIC_KEY_PATH',
  'JWT_ISSUER',
] as const;

function requireEnvironment(): void {
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function checkKeys(): Promise<void> {
  const privatePem = await readFile(process.env.JWT_PRIVATE_KEY_PATH!, 'utf8');
  const publicPem = await readFile(process.env.JWT_PUBLIC_KEY_PATH!, 'utf8');
  const privateKey = await importPKCS8(privatePem, 'RS256');
  const publicKey = await importSPKI(publicPem, 'RS256');
  const issuer = process.env.JWT_ISSUER!;
  const token = await new SignJWT({ preflight: true })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setExpirationTime('1m')
    .sign(privateKey);
  await jwtVerify(token, publicKey, { issuer });
}

async function checkDatabase(name: string, connectionString: string): Promise<void> {
  const client = new pg.Client({
    connectionString,
    options: '-c default_transaction_read_only=on',
  });
  try {
    await client.connect();
    const result = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
    if (result.rows[0]?.read_only !== 'on') {
      throw new Error(`${name} database session is not read-only`);
    }
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkAi(): Promise<void> {
  const baseUrl = process.env.AI_SERVICE_URL!.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`AI health returned HTTP ${response.status}`);
}

async function checkMinio(): Promise<void> {
  if ((process.env.MINIO_ENABLED ?? 'true').toLowerCase() === 'false') return;
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER;
  const secretAccessKey = process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD;
  const bucket = process.env.MINIO_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('MinIO is enabled but endpoint, credentials, or bucket is missing');
  }
  const client = new S3Client({
    endpoint,
    region: process.env.MINIO_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function main(): Promise<void> {
  requireEnvironment();
  await checkKeys();
  console.log('[preflight] JWT keypair: ok');
  await checkDatabase('auth', process.env.AUTH_DATABASE_URL!);
  console.log('[preflight] auth database (read-only): ok');
  await checkDatabase('bhoomi', process.env.BHOOMI_DATABASE_URL!);
  console.log('[preflight] bhoomi database (read-only): ok');
  await checkAi();
  console.log('[preflight] AI service: ok');
  await checkMinio();
  console.log('[preflight] MinIO bucket: ok');
}

main().catch((error) => {
  console.error('[preflight] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
