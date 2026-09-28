import { readFileSync, writeFileSync } from 'fs';
import { completeAnalysisResponse } from '../src/analysis-payload.ts';

const raw = readFileSync('/tmp/nm_row.json', 'utf8');
const row = JSON.parse(raw) as { response: Record<string, unknown>; extraction: unknown };
const out = completeAnalysisResponse(row.response || {}, row.extraction);
writeFileSync('/tmp/analysis_payload_out.json', JSON.stringify(out, null, 2));
console.log('keys', Object.keys(out));
console.log('checks', JSON.stringify(out.checks, null, 2).slice(0, 2500));
