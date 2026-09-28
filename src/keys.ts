import { readFileSync } from 'fs';
import { importPKCS8, importSPKI } from 'jose';
import type { CryptoKey } from 'jose';

const PRIVATE_KEY_PATH = process.env.JWT_PRIVATE_KEY_PATH || './keys/private.pem';
const PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH || './keys/public.pem';

let privateKeyPromise: Promise<CryptoKey> | null = null;
let publicKeyPromise: Promise<CryptoKey> | null = null;

export function getPrivateKey(): Promise<CryptoKey> {
  if (!privateKeyPromise) {
    privateKeyPromise = importPKCS8(readFileSync(PRIVATE_KEY_PATH, 'utf8'), 'RS256');
  }
  return privateKeyPromise;
}

export function getPublicKey(): Promise<CryptoKey> {
  if (!publicKeyPromise) {
    publicKeyPromise = importSPKI(readFileSync(PUBLIC_KEY_PATH, 'utf8'), 'RS256');
  }
  return publicKeyPromise;
}
