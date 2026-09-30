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
  status: 'FOUND' | 'NO_PRIOR_APPLICATION' | 'UNAVAILABLE';
  hasAppliedBefore: boolean;
  message: string;
  priorApplications: {
    applicantId?: unknown;
    industryType?: unknown;
    landDetails?: unknown;
    buildingDetails?: unknown;
  }[];
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
  --bg: #ffffff;
  --card: #f7f9fc;
  --text: #1e293b;
  --muted: #64748b;
  --border: #dce4ef;
  --primary: #1c3e6c;
  --ok: #07834f;
  --ok-bg: #dcfce9;
  --warn: #a66b00;
  --warn-bg: #fff4d8;
  --bad: #c43223;
  --bad-bg: #fee5e2;
  --info: #345fd1;
  --info-bg: #edf2ff;
  --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  padding: 20px 16px 32px;
}
.wrap { max-width: 1100px; margin: 0 auto; }
.header, .section {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 14px;
  overflow: hidden;
}
.header { display: flex; align-items: center; gap: 16px; padding: 20px; }
.header-icon {
  display: grid; place-items: center; flex-shrink: 0;
  width: 52px; height: 52px; border: 2px solid var(--primary);
  border-radius: 50%; color: var(--primary);
}
.header-content { min-width: 0; flex: 1; }
.header h1 { font-size: 20px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
.eyebrow { color: var(--primary); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 4px; }
.metadata { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-top: 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.metadata strong { color: var(--text); font-weight: 500; }
.section > summary, .section-heading {
  padding: 15px 18px; color: var(--text);
  font-size: 13px; font-weight: 650; line-height: 1.5;
}
.section > summary {
  list-style: none; cursor: pointer; user-select: none;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.section > summary::-webkit-details-marker { display: none; }
.section > summary::after {
  content: ""; width: 7px; height: 7px; flex-shrink: 0;
  border-right: 1.5px solid var(--primary); border-bottom: 1.5px solid var(--primary);
  transform: rotate(45deg); margin: -4px 2px 0 8px;
}
.section[open] > summary::after { transform: rotate(-135deg); margin-top: 4px; }
summary:focus-visible, .table-wrap:focus-visible { outline: 2px solid var(--info); outline-offset: -3px; }
.title-left { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; text-transform: uppercase; letter-spacing: .02em; }
.section-description { display: block; color: var(--muted); font-size: 12px; font-weight: 400; margin-top: 3px; }
.section .body { padding: 0 18px 18px; }
.badge { display: inline-block; font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 5px; background: #e9eef5; color: var(--muted); text-transform: none; letter-spacing: normal; }
.badge-ok { background: var(--ok-bg); color: var(--ok); }
.badge-warn { background: var(--warn-bg); color: var(--warn); }
.badge-bad { background: var(--bad-bg); color: var(--bad); }
.badge-info { background: var(--info-bg); color: var(--info); }
.metrics { display: grid; grid-template-columns: 1.3fr repeat(4, 1fr); background: white; border: 1px solid var(--border); border-radius: 6px; padding: 20px 0; }
.metric { padding: 0 16px; text-align: center; border-left: 1px solid var(--border); }
.metric:first-child { border-left: 0; }
.metric dt { color: var(--primary); font-size: 11px; text-transform: uppercase; margin-bottom: 8px; }
.metric dd { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; color: #111827; }
.metric dd small { font-size: 16px; font-weight: 500; }
.metric .value-ok { color: var(--ok); }
.metric .value-bad { color: var(--bad); }
.metric .value-warn { color: var(--warn); }
.support-note { color: var(--muted); font-size: 11px; margin-top: 12px; }
.headline { font-size: 15px; font-weight: 600; color: var(--primary); margin-bottom: 8px; }
.narrative { color: var(--muted); font-size: 13px; line-height: 1.65; margin-bottom: 14px; overflow-wrap: anywhere; }
.two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.card { border: 1px solid var(--border); border-radius: 6px; padding: 14px; background: #fff; overflow-wrap: anywhere; }
.card h3 { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
.card-ok h3 { color: var(--ok); }
.card-warn h3 { color: var(--warn); }
.card ul { padding-left: 18px; }
.card li { font-size: 13px; margin: 5px 0; }
.flag { background: #fff; border: 1px solid var(--border); border-left: 3px solid var(--info); border-radius: 5px; padding: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
.flag:last-child { margin-bottom: 0; }
.flag-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.flag-detail { font-size: 12px; color: var(--muted); }
.sev-critical { border-left-color: var(--bad); }
.sev-warning { border-left-color: var(--warn); }
.sev-verified { border-left-color: var(--ok); }
.sev-info { border-left-color: var(--info); }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
table.data { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 12px; }
table.data th { background: #f0f3f8; color: var(--muted); text-align: left; font-size: 11px; font-weight: 600; padding: 11px 12px; }
table.data td { padding: 14px 12px; border-top: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
table.data tbody tr:hover { background: #f8faff; }
table.data .param { font-weight: 500; width: 23%; }
table.data .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 72px; }
table.data .status { width: 110px; }
table.data .insight { color: var(--muted); line-height: 1.6; }
table.data tfoot td { background: #f0f3f8; font-weight: 600; color: var(--primary); }
.score-bar { height: 5px; background: #e9eef5; border-radius: 999px; overflow: hidden; margin-top: 8px; max-width: 130px; }
.score-bar > span { display: block; height: 100%; background: var(--primary); border-radius: 999px; }
.footer-note { margin-top: 20px; text-align: center; font-size: 11px; color: var(--muted); }
@media (max-width: 720px) {
  body { padding: 12px 8px 24px; }
  .header { padding: 16px 12px; gap: 12px; }
  .header h1 { font-size: 17px; }
  .header-icon { width: 42px; height: 42px; }
  .metadata { flex-direction: column; }
  .section > summary, .section-heading { padding: 12px; }
  .section .body { padding: 0 12px 12px; }
  .two-col { grid-template-columns: 1fr; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 0; }
  .metric { padding: 16px 10px; border-top: 1px solid var(--border); }
  .metric:first-child { grid-column: 1 / -1; border-top: 0; }
  .metric:nth-child(even) { border-left: 0; }
  .metric dd { font-size: 22px; }
}
@media print {
  body { padding: 0; }
  .wrap { max-width: none; }
  .table-wrap { overflow: visible; }
  table.data { min-width: 0; }
  .header, .metrics, tr, .card, .flag { break-inside: avoid; }
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

  const applicant = esc(data.applicantName?.trim() || 'AI Assisted Assessment');
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

  const checkCounts = { passed: 0, flagged: 0, pending: 0 };
  for (const flag of flags) {
    const { rowClass } = flagStatusMeta(flag);
    if (rowClass === 'row-ok') checkCounts.passed++;
    else if (rowClass === 'row-bad' || rowClass === 'row-warn') checkCounts.flagged++;
    else checkCounts.pending++;
  }

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
      const bar = max > 0 ? Math.max(0, Math.min(100, Math.round((score / max) * 100))) : 0;
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
    <span class="header-icon" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M5 24V4h11v20M16 11h7v13M3 24h22M9 8h3M9 12h3M9 16h3M9 24v-4h3v4M19 15h1M19 19h1"/>
      </svg>
    </span>
    <div class="header-content">
      <p class="eyebrow">UPSIDA / AI Assisted Assessment</p>
      <h1>${applicant}</h1>
      <div class="metadata">
        <span><strong>Application ID:</strong> ${esc(data.applicationId)}</span>
        <span><strong>Generated:</strong> ${generatedAt}</span>
      </div>
    </div>
  </header>

  <section class="section" aria-labelledby="overview-heading">
    <h2 class="section-heading" id="overview-heading">
      <span class="title-left">Assessment overview</span>
      <span class="section-description">System-generated score and assessment checks</span>
    </h2>
    <div class="body">
      <dl class="metrics">
        <div class="metric"><dt>System score</dt><dd>${esc(total)}<small> / ${esc(maxScore)}</small></dd></div>
        <div class="metric"><dt>Scoring parameters</dt><dd>${params.length}</dd></div>
        <div class="metric"><dt>Checks passed</dt><dd class="value-ok">${checkCounts.passed}</dd></div>
        <div class="metric"><dt>Checks flagged</dt><dd class="value-bad">${checkCounts.flagged}</dd></div>
        <div class="metric"><dt>Checks pending</dt><dd class="value-warn">${checkCounts.pending}</dd></div>
      </dl>
      <p class="support-note">System-generated scores are provided as decision support. Final assessment is subject to authorised review.</p>
    </div>
  </section>

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
    <summary><span class="title-left">Assessment checks <span class="badge badge-info">${flags.length}</span></span></summary>
    <div class="body">
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable assessment table">
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
          <tbody>${flagRows || '<tr><td colspan="5">No assessment checks</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </details>



  ${(() => {
    const mca = data.mcaVerification;
    if (!mca) {
      return `<details class="section" open>
        <summary><span class="title-left">MCA Verifications <span class="badge badge-warn">Unavailable</span></span></summary>
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
    const isMock = /mock/i.test(mca.status || '') || /mock/i.test(mca.source || '');
    return `<details class="section" open>
    <summary><span class="title-left">MCA Verifications <span class="badge ${isMock ? 'badge-warn' : 'badge-info'}">${esc(isMock ? 'Mock data' : mca.status || 'Status unavailable')}</span></span></summary>
    <div class="body">
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable assessment table">
        <table class="data">
          <thead><tr><th>Field</th><th>MCA record</th></tr></thead>
          <tbody>
            <tr><td class="param">Status</td><td>${esc(mca.status || 'N/A')}</td></tr>
            <tr><td class="param">Source</td><td>${esc(mca.source || 'N/A')}</td></tr>
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
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable assessment table">
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

  <details class="section" open>
    <summary><span class="title-left">GST Verifications <span class="badge badge-info">${comparisons.length}</span></span></summary>
    <div class="body">
      <p class="narrative">Comparison of GST records with information provided in the application/DPR.</p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable assessment table">
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

  <details class="section" open>
    <summary><span class="title-left">Marks evaluation <span class="badge badge-info">${esc(total)} / ${esc(maxScore)}</span></span></summary>
    <div class="body">
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable assessment table">
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

  ${(() => {
    const hist = data.historyVerification;
    const applied = hist?.hasAppliedBefore === true;
    const unavailable = !hist || hist.status === 'UNAVAILABLE';
    const msg = hist?.message || (unavailable ? 'History lookup unavailable.' : applied ? 'Prior land allotments found.' : 'No prior application.');
    const projects = hist?.priorApplications || [];
    const projectRows = projects.map((project) => `<tr>
      <td>${esc(project.applicantId)}</td>
      <td>${esc(project.industryType)}</td>
      <td>${esc(project.landDetails)}</td>
      <td>${esc(project.buildingDetails)}</td>
    </tr>`).join('');
    const badge = unavailable ? 'badge-warn' : applied ? 'badge-warn' : 'badge-ok';
    const label = unavailable ? 'Lookup unavailable' : applied ? 'Prior application' : 'No prior application';
    return `<details class="section" open>
    <summary><span><span class="title-left">Historical records <span class="badge ${badge}">${label}</span></span><span class="section-description">Previous applications and allotment history with UPSIDA.</span></span></summary>
    <div class="body">
      <div class="card ${applied || unavailable ? 'card-warn' : 'card-ok'}">
        <h3>Lands allotted for this applicant</h3>
        <p class="narrative" style="margin:0;font-weight:700;color:var(--text)">${esc(msg)}</p>
        ${projects.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Historical records table" style="margin-top:14px"><table class="data">
          <thead><tr><th>Applicant ID</th><th>Industry Type</th><th>Land Details</th><th>Building Details</th></tr></thead>
          <tbody>${projectRows}</tbody>
        </table></div>` : ''}
      </div>
    </div>
  </details>`;
  })()}

  <p class="footer-note">UPSIDA AI Assisted Assessment</p>
</div>
</body>
</html>`;

  return compactHtml(html);
}
