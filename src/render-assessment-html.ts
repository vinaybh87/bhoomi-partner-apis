// Self-contained, beautified AI Assessment HTML for SaveAssessment.HTMLDetails.
// Inline CSS only; collapsible sections; tables + color coding. Output is
// compacted then base64-encoded by the caller.
export type McaVerification = {
  status?: string;
  source?: string;
  cin?: string | null;
  companyName?: string | null;
  companyStatus?: string | null;
  dateOfIncorporation?: string | null;
  registeredAddress?: string | null;
  directors?: { name: string; designation?: string }[];
  findings?: { severity?: string; title: string; detail: string }[];
};

export type HistoryVerification = {
  hasAppliedBefore: boolean;
  message: string;
};

export type AssessmentHtmlInput = {
  applicationId: string;
  generatedAt?: string;
  aiSuggestedScore: { value: number; scale: number; passMark: number };
  marksEvaluation: {
    total: number;
    max: number;
    passMark: number;
    result: string;
    parameters: { parameter: string; score: number; max: number; insight: string }[];
  };
  comparisons: unknown;
  flags: unknown;
  summary: unknown;
  mcaVerification?: McaVerification | null;
  historyVerification?: HistoryVerification | null;
  applicantName?: string;
  evaluatorName?: string;
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
}

function compactHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function severityClass(sev: string): string {
  const s = sev.toLowerCase();
  if (s === 'critical') return 'sev-critical';
  if (s === 'warning') return 'sev-warning';
  if (s === 'verified') return 'sev-verified';
  return 'sev-info';
}

function leanClass(lean: string): string {
  const s = lean.toLowerCase();
  if (s === 'approve' || s === 'forward') return 'lean-ok';
  if (s === 'reject') return 'lean-bad';
  if (s === 'conditional' || s === 'review') return 'lean-warn';
  return 'lean-neutral';
}

const INLINE_CSS = `
:root {
  --bg: #eef1f6;
  --card: #ffffff;
  --text: #111827;
  --muted: #4b5563;
  --border: #94a3b8;
  --border-soft: #cbd5e1;
  --primary: #0b3d6e;
  --ok: #047857;
  --ok-bg: #ecfdf5;
  --warn: #b45309;
  --warn-bg: #fffbeb;
  --bad: #b91c1c;
  --bad-bg: #fef2f2;
  --info: #1d4ed8;
  --info-bg: #eff6ff;
  --table-head: #0b3d6e;
  --shadow: 0 2px 6px rgba(15,23,42,.10);
  --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text);
  background: var(--bg);
  padding: 20px 16px 40px;
}
.wrap { max-width: 1100px; margin: 0 auto; }
.header {
  background: linear-gradient(135deg, #0b3d6e 0%, #155e9c 55%, #0f766e 100%);
  color: #fff;
  border: 2px solid #082f54;
  border-radius: var(--radius);
  padding: 22px 24px;
  box-shadow: var(--shadow);
  margin-bottom: 18px;
}
.header h1 {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: .01em;
  margin-bottom: 8px;
  line-height: 1.2;
}
.header .sub {
  opacity: .95;
  font-size: 13px;
  font-weight: 600;
  border-top: 1px solid rgba(255,255,255,.35);
  padding-top: 10px;
  margin-top: 4px;
}
.pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255,255,255,.18);
  border: 1.5px solid rgba(255,255,255,.45);
  color: #fff;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}
.pill strong { font-weight: 800; }
.lean-ok { background: #059669; border-color: #047857; }
.lean-warn { background: #d97706; border-color: #b45309; }
.lean-bad { background: #dc2626; border-color: #b91c1c; }
.lean-neutral { background: rgba(255,255,255,.22); }

.section {
  background: var(--card);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  margin-bottom: 14px;
  overflow: hidden;
}
.section > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 15px 18px;
  background: #f1f5f9;
  border-bottom: 2px solid transparent;
  font-weight: 800;
  font-size: 15.5px;
  color: var(--primary);
  letter-spacing: .01em;
}
.section > summary::-webkit-details-marker { display: none; }
.section > summary::after {
  content: "";
  width: 9px;
  height: 9px;
  border-right: 2.5px solid var(--primary);
  border-bottom: 2.5px solid var(--primary);
  transform: rotate(45deg);
  transition: transform .15s ease;
  flex-shrink: 0;
  margin-top: -4px;
}
.section[open] > summary {
  border-bottom: 2px solid var(--border);
  background: #e2eef9;
}
.section[open] > summary::after {
  transform: rotate(-135deg);
  margin-top: 4px;
}
.section .body {
  padding: 16px 18px 18px;
  border-top: 0;
}
.section .title-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-weight: 800;
}
.badge {
  font-size: 11px;
  font-weight: 800;
  padding: 3px 9px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #1e293b;
  border: 1px solid #94a3b8;
}
.badge-ok { background: var(--ok-bg); color: var(--ok); border-color: #6ee7b7; }
.badge-warn { background: var(--warn-bg); color: var(--warn); border-color: #fcd34d; }
.badge-bad { background: var(--bad-bg); color: var(--bad); border-color: #fca5a5; }
.badge-info { background: var(--info-bg); color: var(--info); border-color: #93c5fd; }

.headline {
  font-size: 17px;
  font-weight: 800;
  color: var(--text);
  margin-bottom: 12px;
  line-height: 1.35;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--border);
}
.narrative {
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.65;
  margin-bottom: 14px;
  font-weight: 500;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 720px) {
  .two-col { grid-template-columns: 1fr; }
}
.card {
  border-radius: 8px;
  border: 2px solid var(--border-soft);
  padding: 12px 14px;
  background: #fafbfc;
}
.card h3 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: .05em;
  margin-bottom: 10px;
  font-weight: 800;
  padding-bottom: 6px;
  border-bottom: 2px solid currentColor;
}
.card-ok { border-color: #34d399; background: var(--ok-bg); }
.card-ok h3 { color: var(--ok); }
.card-warn { border-color: #fbbf24; background: var(--warn-bg); }
.card-warn h3 { color: var(--warn); }
.card-bad { border-color: #f87171; background: var(--bad-bg); }
.card-bad h3 { color: var(--bad); }
.card ul { margin: 0; padding-left: 18px; }
.card li {
  margin: 6px 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
}

.flag {
  border: 1.5px solid var(--border-soft);
  border-left: 5px solid #64748b;
  background: #f8fafc;
  border-radius: 0 8px 8px 0;
  padding: 11px 13px;
  margin-bottom: 10px;
}
.flag:last-child { margin-bottom: 0; }
.flag .flag-title {
  font-weight: 800;
  font-size: 13.5px;
  margin-bottom: 4px;
  color: var(--text);
}
.flag .flag-meta {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 5px;
  text-transform: uppercase;
  letter-spacing: .03em;
}
.flag .flag-detail {
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
  font-weight: 500;
}
.sev-critical { border-left-color: var(--bad); border-color: #fca5a5; background: var(--bad-bg); }
.sev-warning { border-left-color: var(--warn); border-color: #fcd34d; background: var(--warn-bg); }
.sev-verified { border-left-color: var(--ok); border-color: #6ee7b7; background: var(--ok-bg); }
.sev-info { border-left-color: var(--info); border-color: #93c5fd; background: var(--info-bg); }

.table-wrap {
  overflow-x: auto;
  border: 2px solid var(--border);
  border-radius: 8px;
}
table.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 560px;
}
table.data thead th {
  background: var(--table-head);
  color: #fff;
  text-align: left;
  padding: 11px 12px;
  font-weight: 800;
  white-space: nowrap;
  border: 1px solid #082f54;
  font-size: 12.5px;
  letter-spacing: .02em;
  text-transform: uppercase;
}
table.data tbody td {
  padding: 11px 12px;
  border: 1px solid var(--border-soft);
  vertical-align: top;
  color: var(--text);
}
table.data tbody tr:nth-child(even) { background: #f1f5f9; }
table.data tbody tr:hover { background: #e0f2fe; }
table.data tbody tr.row-ok,
table.data tbody tr.row-ok:nth-child(even) { background: var(--ok-bg); }
table.data tbody tr.row-ok:hover { background: #d1fae5; }
table.data tbody tr.row-warn,
table.data tbody tr.row-warn:nth-child(even) { background: var(--warn-bg); }
table.data tbody tr.row-warn:hover { background: #fde68a; }
table.data tbody tr.row-bad,
table.data tbody tr.row-bad:nth-child(even) { background: var(--bad-bg); }
table.data tbody tr.row-bad:hover { background: #fecaca; }
table.data tbody tr.row-info,
table.data tbody tr.row-info:nth-child(even) { background: var(--info-bg); }
table.data tbody tr.row-info:hover { background: #dbeafe; }
table.data td.status { white-space: nowrap; width: 110px; }
table.data td.param {
  font-weight: 800;
  color: var(--primary);
  width: 22%;
}
table.data td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  white-space: nowrap;
  width: 72px;
}
table.data td.insight {
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
  font-weight: 500;
}
table.data tfoot td {
  background: #dbeafe;
  font-weight: 800;
  padding: 12px;
  border: 1px solid var(--border);
  border-top: 3px solid var(--primary);
  color: var(--text);
}
.score-bar {
  height: 9px;
  background: #e2e8f0;
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 6px;
  max-width: 130px;
}
.score-bar > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #0d9488, #0b3d6e);
  border-radius: 999px;
}
.footer-note {
  margin-top: 18px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  border-top: 2px solid var(--border-soft);
  padding-top: 12px;
}
`.replace(/\s+/g, ' ').trim();

/**
 * Returns one self-contained HTML document (CSS inlined in <style>).
 * Compacted for safe embedding / base64 transport.
 */
export function renderAssessmentHtml(data: AssessmentHtmlInput): string {
  const summary =
    data.summary && typeof data.summary === 'object'
      ? (data.summary as Record<string, unknown>)
      : {};
  const headline = esc(summary.headline ?? 'AI Assisted Assessment');
  const narrative = esc(summary.narrative ?? '');
  const lean = String(summary.lean ?? '');
  const strengths = Array.isArray(summary.strengths)
    ? (summary.strengths as unknown[]).map((s) => esc(s))
    : [];
  const concerns = Array.isArray(summary.concerns)
    ? (summary.concerns as unknown[]).map((s) => esc(s))
    : [];

  const flags = asArray(data.flags);

  const comparisons = asArray(data.comparisons);
  const params = data.marksEvaluation?.parameters ?? [];
  const total = data.marksEvaluation?.total ?? data.aiSuggestedScore?.value ?? 0;
  const maxScore = data.marksEvaluation?.max ?? data.aiSuggestedScore?.scale ?? 100;
  const passMark = data.marksEvaluation?.passMark ?? data.aiSuggestedScore?.passMark ?? 60;
  const pct = maxScore > 0 ? Math.min(100, Math.round((total / maxScore) * 100)) : 0;

  const applicant = esc(data.applicantName ?? data.applicationId);
  const generatedAt = esc(data.generatedAt ?? new Date().toISOString());

  const strengthLis = strengths.map((s) => `<li>${s}</li>`).join('') || '<li>None listed</li>';
  const concernLis = concerns.map((s) => `<li>${s}</li>`).join('') || '<li>None listed</li>';

  const flagStatusMeta = (f: Record<string, unknown>) => {
    const status = String(f.status ?? '').trim();
    const sev = String(f.severity ?? '').toLowerCase();
    const passed = f.passed === true;
    const label =
      status ||
      (passed
        ? 'Passed'
        : sev === 'critical'
          ? 'Flagged'
          : sev === 'warning'
            ? 'Flagged'
            : sev === 'verified'
              ? 'Passed'
              : 'Pending');
    const lower = label.toLowerCase();
    if (lower === 'passed' || sev === 'verified') {
      return { label, rowClass: 'row-ok', badge: 'badge-ok' };
    }
    if (lower === 'flagged' || sev === 'critical') {
      return { label, rowClass: 'row-bad', badge: 'badge-bad' };
    }
    if (sev === 'warning' || lower === 'warning') {
      return { label, rowClass: 'row-warn', badge: 'badge-warn' };
    }
    return { label: label || 'Pending', rowClass: 'row-info', badge: 'badge-info' };
  };

  const flagRows = flags
    .map((f) => {
      const meta = flagStatusMeta(f);
      const number = f.number ?? f.external_ref ?? '';
      const stage = f.stage ?? f.source ?? 'Investor analysis';
      const check = f.check ?? f.title ?? '';
      const remarks = f.remarks ?? f.detail ?? '';
      return `<tr class="${meta.rowClass}">
        <td class="num">${esc(number)}</td>
        <td class="param">${esc(stage)}</td>
        <td>${esc(check)}</td>
        <td class="status"><span class="badge ${meta.badge}">${esc(meta.label)}</span></td>
        <td class="insight">${esc(remarks)}</td>
      </tr>`;
    })
    .join('');

  const cmpRows = comparisons
    .map((c) => {
      const label = c.label ?? c.parameter ?? '';
      const dpr = c.dpr_value ?? c.dprValue ?? '';
      const gst = c.gst_value ?? c.gstValue ?? '';
      const note = c.note ?? c.insight ?? '';
      return `<tr>
        <td class="param">${esc(label)}</td>
        <td>${esc(dpr)}</td>
        <td>${esc(gst)}</td>
        <td class="insight">${esc(note)}</td>
      </tr>`;
    })
    .join('');

  const markRows = params
    .map((p) => {
      const max = Number(p.max) || 0;
      const score = Number(p.score) || 0;
      const bar = max > 0 ? Math.min(100, Math.round((score / max) * 100)) : 0;
      return `<tr>
        <td class="param">${esc(p.parameter)}</td>
        <td class="num">${esc(score)}</td>
        <td class="num">${esc(max)}</td>
        <td class="insight">${esc(p.insight)}
          <div class="score-bar"><span style="width:${bar}%"></span></div>
        </td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>UPSIDA AI Assisted Assessment</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="header">
    <h1>AI Assisted Assessment</h1>
    <div class="sub">Application: <strong>${applicant}</strong> · Generated ${generatedAt}</div>
    <div class="pills">
      <span class="pill">Score <strong>${esc(total)}</strong> / ${esc(maxScore)}</span>
    </div>
  </header>

  <details class="section" open>
    <summary><span class="title-left">Summary <span class="badge ${leanClass(lean) === 'lean-bad' ? 'badge-bad' : leanClass(lean) === 'lean-ok' ? 'badge-ok' : 'badge-warn'}">${esc(lean || 'summary')}</span></span></summary>
    <div class="body">
      <div class="headline">${headline}</div>
      <p class="narrative">${narrative}</p>
      <div class="two-col">
        <div class="card card-ok">
          <h3>Strengths</h3>
          <ul>${strengthLis}</ul>
        </div>
        <div class="card card-warn">
          <h3>Concerns</h3>
          <ul>${concernLis}</ul>
        </div>
      </div>
    </div>
  </details>

  <details class="section" open>
    <summary><span class="title-left">Flags <span class="badge badge-info">${flags.length}</span></span></summary>
    <div class="body">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Stage</th>
              <th>Check</th>
              <th>Status</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>${flagRows || '<tr><td colspan="5">No flags</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </details>

  <details class="section">
    <summary><span class="title-left">DPR vs GST comparisons <span class="badge badge-info">${comparisons.length}</span></span></summary>
    <div class="body">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Parameter</th>
              <th>DPR</th>
              <th>GST</th>
              <th>AI analysis</th>
            </tr>
          </thead>
          <tbody>${cmpRows || '<tr><td colspan="4">No comparisons</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </details>

  ${(() => {
    const mca = data.mcaVerification;
    if (!mca) {
      return `<details class="section">
        <summary><span class="title-left">MCA verification <span class="badge badge-info">mca.gov.in</span></span></summary>
        <div class="body"><p class="narrative">MCA verification not available.</p></div>
      </details>`;
    }
    const directors = Array.isArray(mca.directors) ? mca.directors : [];
    const findings = Array.isArray(mca.findings) ? mca.findings : [];
    const dirRows = directors
      .map(
        (d) =>
          `<tr><td class="param">${esc(d.name)}</td><td>${esc(d.designation || 'Director')}</td></tr>`
      )
      .join('');
    const findHtml = findings.length
      ? findings
          .map(
            (f) => `<div class="flag ${severityClass(String(f.severity || 'info'))}">
          <div class="flag-title">${esc(f.title)}</div>
          <div class="flag-detail">${esc(f.detail)}</div>
        </div>`
          )
          .join('')
      : '';
    return `<details class="section">
    <summary><span class="title-left">MCA verification <span class="badge badge-info">mca.gov.in</span></span></summary>
    <div class="body">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Field</th><th>MCA record</th></tr></thead>
          <tbody>
            <tr><td class="param">Status</td><td>${esc(mca.status || 'MOCK')}</td></tr>
            <tr><td class="param">Source</td><td>${esc(mca.source || 'mca.gov.in (mock)')}</td></tr>
            <tr><td class="param">CIN</td><td>${esc(mca.cin || 'N/A')}</td></tr>
            <tr><td class="param">Company name</td><td>${esc(mca.companyName || 'N/A')}</td></tr>
            <tr><td class="param">Company status</td><td>${esc(mca.companyStatus || 'N/A')}</td></tr>
            <tr><td class="param">Date of incorporation</td><td>${esc(mca.dateOfIncorporation || 'N/A')}</td></tr>
            <tr><td class="param">Registered address</td><td>${esc(mca.registeredAddress || 'N/A')}</td></tr>
          </tbody>
        </table>
      </div>
      ${
        directors.length
          ? `<div class="headline" style="margin-top:14px">Directors (MCA)</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Name</th><th>Designation</th></tr></thead>
          <tbody>${dirRows}</tbody>
        </table>
      </div>`
          : ''
      }
      ${findings.length ? `<div class="headline" style="margin-top:14px">MCA findings</div>${findHtml}` : ''}
    </div>
  </details>`;
  })()}

  ${(() => {
    const hist = data.historyVerification;
    const applied = hist?.hasAppliedBefore === true;
    const msg =
      hist?.message ||
      (applied ? 'Had applied before' : 'Had not applied before');
    return `<details class="section">
    <summary><span class="title-left">History verification <span class="badge ${applied ? 'badge-warn' : 'badge-ok'}">${applied ? 'Prior application' : 'No prior application'}</span></span></summary>
    <div class="body">
      <div class="card ${applied ? 'card-warn' : 'card-ok'}">
        <h3>Application history</h3>
        <p class="narrative" style="margin:0;font-weight:700;color:var(--text)">${esc(msg)}</p>
        <p class="narrative" style="margin-top:8px">Has applied before: <strong>${applied ? 'Yes' : 'No'}</strong></p>
      </div>
    </div>
  </details>`;
  })()}

  <details class="section">
    <summary><span class="title-left">Marks evaluation <span class="badge badge-info">${esc(total)} / ${esc(maxScore)}</span></span></summary>
    <div class="body">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Parameter</th>
              <th class="num">Score</th>
              <th class="num">Max</th>
              <th>Insight</th>
            </tr>
          </thead>
          <tbody>${markRows || '<tr><td colspan="4">No marks</td></tr>'}</tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td class="num">${esc(total)}</td>
              <td class="num">${esc(maxScore)}</td>
              <td>Pass mark: ${esc(passMark)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  </details>

  <p class="footer-note">UPSIDA AI Assisted Assessment · collapsible sections · inline CSS · base64 transport</p>
</div>
</body>
</html>`;

  return compactHtml(html);
}
