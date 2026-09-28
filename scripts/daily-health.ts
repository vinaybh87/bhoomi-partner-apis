// Daily 10:00 IST Slack health.
// Only what this pipeline uses: partner APIs, AI 8422, its Postgres/MinIO
// containers, and live Mistral + Claude key checks. Never prints secrets.
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);

const SLACK_WEBHOOK_URL = process.env.SLACK_ALERTS_WEBHOOK_URL || '';
const APIS_URL = (process.env.HEALTH_APIS_URL || `http://127.0.0.1:${process.env.PORT || 8011}`).replace(
  /\/$/,
  ''
);
const AI_URL = (process.env.HEALTH_AI_URL || process.env.AI_SERVICE_URL || 'http://127.0.0.1:8422').replace(
  /\/$/,
  ''
);
const AI_ENV_PATH =
  process.env.HEALTH_AI_ENV_PATH ||
  '/home/ubuntu/main-api-bs/bhoomi-suvidha-upsida-ai-service/.env';

const USED_CONTAINERS = (process.env.HEALTH_CONTAINERS || 'bhoomi-suvidha-postgres-1,bhoomi-minio')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type Check = { name: string; ok: boolean; detail: string };

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

function redact(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-[redacted]')
    .slice(0, 180);
}

async function httpGet(name: string, url: string): Promise<Check> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    return { name, ok: res.ok, detail: `HTTP ${res.status} in ${Date.now() - t0}ms` };
  } catch (err) {
    return { name, ok: false, detail: redact(err instanceof Error ? err.message : String(err)) };
  }
}

async function containerHealth(name: string): Promise<Check> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}', name],
      { timeout: 8000 }
    );
    const line = stdout.trim();
    const [status, health] = line.split(/\s+/);
    const running = status === 'running';
    const healthy = health === 'healthy' || health === 'no-healthcheck';
    return {
      name: `container ${name}`,
      ok: running && healthy,
      detail: running
        ? `running · health=${health}`
        : `not running (state=${status || 'unknown'})`,
    };
  } catch {
    return { name: `container ${name}`, ok: false, detail: 'not found / docker inspect failed' };
  }
}

async function mistralWorks(key: string | undefined): Promise<Check> {
  const name = 'Mistral key';
  if (!key) return { name, ok: false, detail: 'MISTRAL_API_KEY not set' };
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.mistral.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const ms = Date.now() - t0;
    if (res.status === 402) return { name, ok: false, detail: `HTTP 402 billing/subscription (${ms}ms)` };
    if (res.status === 401) return { name, ok: false, detail: `HTTP 401 key rejected (${ms}ms)` };
    if (!res.ok) return { name, ok: false, detail: `HTTP ${res.status} (${ms}ms)` };
    return { name, ok: true, detail: `works · HTTP ${res.status} in ${ms}ms` };
  } catch (err) {
    return { name, ok: false, detail: redact(err instanceof Error ? err.message : String(err)) };
  }
}

async function claudeWorks(key: string | undefined): Promise<Check> {
  const name = 'Claude key';
  if (!key) return { name, ok: false, detail: 'ANTHROPIC_API_KEY not set' };
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    });
    const ms = Date.now() - t0;
    if (res.status === 401) return { name, ok: false, detail: `HTTP 401 key rejected (${ms}ms)` };
    if (!res.ok) return { name, ok: false, detail: `HTTP ${res.status} (${ms}ms)` };
    return { name, ok: true, detail: `works · HTTP ${res.status} in ${ms}ms` };
  } catch (err) {
    return { name, ok: false, detail: redact(err instanceof Error ? err.message : String(err)) };
  }
}

async function main() {
  const aiEnv = parseEnvFile(AI_ENV_PATH);
  const checks: Check[] = [];

  checks.push(await httpGet('Partner APIs', `${APIS_URL}/health`));
  checks.push(await httpGet('AI service (8422)', `${AI_URL}/health`));
  for (const c of USED_CONTAINERS) checks.push(await containerHealth(c));
  checks.push(await mistralWorks(aiEnv.MISTRAL_API_KEY));
  checks.push(await claudeWorks(aiEnv.ANTHROPIC_API_KEY));

  const failed = checks.filter((c) => !c.ok);
  const allOk = failed.length === 0;
  const names = checks.map((c) => c.name.replace(/^container /, '')).join(', ');
  const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`).join('\n');
  const header = allOk
    ? 'Daily Health Check: All systems OK'
    : `Daily Health Check: ${failed.length} issue(s)`;
  const issueBlock = allOk
    ? `*Checked*\n${names}`
    : `*Issue*\n${failed.map((c) => `• ${c.name}: ${c.detail}`).join('\n')}`;
  const actions = allOk
    ? ['No action needed.']
    : [
        'If Partner APIs is down: `pm2 list` / `pm2 logs bhoomi-partner-apis`.',
        'If AI 8422 is down: `ss -lptn | grep 8422` and `tail /tmp/ai-service-8422.log`.',
        'If a container is unhealthy: `docker ps -a` and `docker logs <name> --tail 50`.',
        'If Mistral 402: top up https://admin.mistral.ai/subscription.',
        'If Claude 401: update ANTHROPIC_API_KEY on the 8422 .env and restart uvicorn.',
      ];

  console.log(`[daily-health] ${header}`);
  console.log(lines);

  if (!SLACK_WEBHOOK_URL) {
    console.error('[daily-health] SLACK_ALERTS_WEBHOOK_URL not set');
    process.exit(2);
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: header,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: header.slice(0, 150), emoji: true },
        },
        { type: 'section', text: { type: 'mrkdwn', text: issueBlock } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Error Code*\n\`${allOk ? 'HEALTH_OK' : 'HEALTH_DEGRADED'}\`` },
        },
        { type: 'section', text: { type: 'mrkdwn', text: `*Checks*\n\`\`\`${lines.slice(0, 2500)}\`\`\`` } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Actions*\n${actions.map((c, i) => `${i + 1}. ${c}`).join('\n')}` },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`[daily-health] slack http=${res.status} ${(await res.text()).slice(0, 40)}`);
  if (!allOk || !res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[daily-health] crashed', err);
  process.exit(1);
});
