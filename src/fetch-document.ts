// Fetch partner document URLs. Nivesh Mitra hosts docs on HTTPS with a
// self-signed cert (e.g. 49.50.109.86:8087) — Node's default fetch rejects
// that and analysis fails as FILE_ACCESS_ERROR / UI ERROR_IN_ANALYSIS.
import https from 'https';
import http from 'http';
import { URL } from 'url';

const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

export async function fetchDocumentBuffer(
  url: string,
  opts: { timeoutMs?: number } = {}
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const parsed = new URL(url);

  // Prefer native fetch for public CA-backed hosts; fall back to insecure
  // agent when TLS verification fails (NM document server).
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`signed URL returned HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeTls =
      msg.includes('certificate') ||
      msg.includes('SSL') ||
      msg.includes('TLS') ||
      msg.includes('self-signed') ||
      msg.includes('unable to verify') ||
      msg.includes('fetch failed');
    if (parsed.protocol !== 'https:' || !looksLikeTls) {
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const req = https.get(
      url,
      { agent: insecureHttpsAgent, timeout: timeoutMs },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // One redirect hop
          fetchDocumentBuffer(res.headers.location, opts).then(resolve, reject);
          res.resume();
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`signed URL returned HTTP ${res.statusCode ?? 0}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`document fetch timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

/** HTTP helper kept for symmetry (unsigned local test servers). */
export async function fetchHttpBuffer(url: string, timeoutMs = 90_000): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return fetchDocumentBuffer(url, { timeoutMs });
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`URL returned HTTP ${res.statusCode ?? 0}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`document fetch timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}
