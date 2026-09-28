// Renders a single root <div> fragment: the raw analysis JSON on top,
// then the styled evaluation report below it (gradient header, pass/flag/
// pending summary, badge table) — design matches the approved reference.
// Served by /v1/analysis and GET /v1/analysis/:analysisId when called with
// ?format=html (and stored on the JSON response as `html`).
import {
  buildInvestorStages,
  type ApplicationChecks,
  type ThirdPartyVerification,
  type ApplicantHistory,
  type InvestorStageRow,
} from './checks.js';

interface RenderInput {
  analysisId: string;
  applicationId: string;
  companyName?: string | null;
  checks: ApplicationChecks;
  thirdPartyVerification: ThirdPartyVerification;
  applicantHistory: ApplicantHistory;
  status: string;
  stages?: InvestorStageRow[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeFor(status: InvestorStageRow['status']): string {
  if (status === 'Passed') return '<span class="badge success">Passed</span>';
  if (status === 'Pending') return '<span class="badge pendingBadge">Pending</span>';
  return '<span class="badge warning">Flagged</span>';
}

function shortenFormVsDpr(raw: string): string {
  if (!raw) return raw;
  if (raw.includes('DPR proposed')) {
    return raw
      .replace(/\s*Capital investment[\s\S]*$/i, '')
      .trim();
  }
  const lines: string[] = [];
  const inv = raw.match(
    /Proposed investment \(form: (₹[\d.]+ Lakh), DPR total project cost: (₹[\d.]+ Lakh)\)/i
  );
  if (inv) lines.push(`DPR proposed ${inv[2]} for total project cost; form has ${inv[1]}.`);
  const land = raw.match(
    /Land area \(form: ([\d.]+ sq\.m), DPR land requirement: ([\d.]+ sq\.m)\)/i
  );
  if (land) lines.push(`DPR proposed ${land[2]} for land; form has ${land[1]}.`);
  const landCost = raw.match(
    /Land investment \(form: (₹[\d.]+ Lakh), DPR land cost: (₹[\d.]+ Lakh)\)/i
  );
  if (landCost) lines.push(`DPR proposed ${landCost[2]} for land cost; form has ${landCost[1]}.`);
  const building = raw.match(
    /Building investment \(form: (₹[\d.]+ Lakh), DPR land and building: (₹[\d.]+ Lakh)/i
  );
  if (building) {
    lines.push(`DPR proposed ${building[2]} for land and building; form has ${building[1]}.`);
  }
  if (lines.length) return lines.join('\n');
  return raw.replace(/\s*Capital investment[\s\S]*$/i, '').trim() || raw;
}

function remarksForHtml(s: InvestorStageRow): string {
  const check = `${s.check || s.label || ''}`.toLowerCase();
  const raw = `${s.remarks || s.note || ''}`.trim();
  if (check.includes('form vs dpr') || check.includes('form vs dpr comparison')) {
    return shortenFormVsDpr(raw);
  }
  if (check.includes('uploaded document') || check.includes('document verification')) {
    return s.status === 'Passed' ? raw || 'Document found.' : 'Document not found.';
  }
  if (check.includes('signature')) {
    return s.status === 'Passed' ? 'Signature found.' : 'Signature not found.';
  }
  if (/ocr|identity ocr|validated by ocr/i.test(raw)) {
    return s.status === 'Passed' ? 'Check passed.' : 'Document not found.';
  }
  return raw;
}

function stageRow(s: InvestorStageRow): string {
  const remarks = escapeHtml(remarksForHtml(s)).replace(/\n/g, '<br>');
  return `
<tr>
<td class="step">${escapeHtml(s.stage)}</td>
<td>${escapeHtml(s.check || s.label)}</td>
<td>${badgeFor(s.status)}</td>
<td class="details">${remarks}</td>
</tr>`;
}

export function renderAnalysisHtml(data: RenderInput): string {
  const tpv = data.thirdPartyVerification;
  const title = data.companyName || data.applicationId;
  const stages = data.stages ?? buildInvestorStages(data.checks, tpv);

  const passedCount = stages.filter((s) => s.status === 'Passed').length;
  const flaggedCount = stages.filter((s) => s.status === 'Flagged').length;
  const pendingCount = stages.filter((s) => s.status === 'Pending').length;

  const overallTitle = flaggedCount > 0 ? 'Review Required' : 'All Checks Passed';
  const overallNote =
    flaggedCount > 0
      ? `${flaggedCount} validation ${flaggedCount === 1 ? 'check requires' : 'checks require'} attention before the application can proceed.`
      : 'All validation checks completed successfully.';

  const rawData = {
    analysisId: data.analysisId,
    applicationId: data.applicationId,
    status: data.status,
    checks: stages.map((s) => ({
      number: s.number,
      stage: s.stage,
      check: s.check,
      status: s.status,
      passed: s.passed,
      remarks: remarksForHtml(s),
    })),
    applicantHistory: {
      status:
        data.applicantHistory.status === 'NOT_INTEGRATED'
          ? 'Not integrated'
          : data.applicantHistory.status,
      note: data.applicantHistory.note,
    },
  };

  // Single root div (no <html>/<head>/<body>) so callers can embed the
  // fragment directly. Styles are scoped under .bs-analysis-report.
  return `<div class="bs-analysis-report">
<style>
.bs-analysis-report{
    margin:0;
    background:#f6f7fb;
    font-family:"Segoe UI",Arial,sans-serif;
    color:#333;
    box-sizing:border-box;
}
.bs-analysis-report *,.bs-analysis-report *::before,.bs-analysis-report *::after{box-sizing:border-box}
.bs-analysis-report .container{
    width:950px;
    max-width:100%;
    margin:30px auto;
    background:#fff;
    border-radius:14px;
    overflow:hidden;
    box-shadow:0 8px 30px rgba(0,0,0,.08);
}
.bs-analysis-report .header{
    background:linear-gradient(90deg,#ff8b00 0%,#ff4d6d 50%,#8b3dff 100%);
    color:#fff;
    padding:40px;
    text-align:center;
}
.bs-analysis-report .title h1{
    margin:0;
    font-size:34px;
    font-weight:700;
}
.bs-analysis-report .title p{
    margin:10px 0 0;
    font-size:15px;
    line-height:1.6;
    opacity:.95;
}
.bs-analysis-report .company{
    padding:35px 40px 15px;
}
.bs-analysis-report .company-name{
    font-size:30px;
    font-weight:700;
}
.bs-analysis-report .company-sub{
    color:#777;
    margin-top:6px;
    font-size:15px;
}
.bs-analysis-report .overall{
    margin:15px 40px 35px;
    background:linear-gradient(90deg,#fff4e5,#fff);
    border-left:6px solid #ff7a00;
    border-radius:12px;
    padding:22px;
}
.bs-analysis-report .overall h2{
    margin:0;
    color:#d35400;
}
.bs-analysis-report .overall p{
    margin:8px 0 0;
    color:#555;
}
.bs-analysis-report .summary{
    display:flex;
    gap:30px;
    margin-top:15px;
    font-weight:600;
}
.bs-analysis-report .pass{color:#1b8f3b}
.bs-analysis-report .flag{color:#e67e22}
.bs-analysis-report .pending{color:#777}
.bs-analysis-report .section{
    padding:0 40px 40px;
}
.bs-analysis-report table{
    width:100%;
    border-collapse:collapse;
}
.bs-analysis-report th{
    background:#f4f5f8;
    text-transform:uppercase;
    font-size:12px;
    text-align:left;
    padding:16px;
}
.bs-analysis-report td{
    padding:18px 16px;
    border-bottom:1px solid #ececec;
    vertical-align:top;
}
.bs-analysis-report tr:hover{background:#fafafa}
.bs-analysis-report .step{font-weight:700}
.bs-analysis-report .badge{
    display:inline-block;
    padding:6px 14px;
    border-radius:999px;
    color:#fff;
    font-size:12px;
    font-weight:700;
}
.bs-analysis-report .success{background:#2ecc71}
.bs-analysis-report .warning{background:#f39c12}
.bs-analysis-report .pendingBadge{background:#95a5a6}
.bs-analysis-report .details{
    color:#555;
    line-height:1.6;
}
.bs-analysis-report .raw{
    width:950px;
    max-width:100%;
    margin:30px auto 0;
}
.bs-analysis-report .raw h2{
    font-size:13px;
    font-weight:700;
    color:#555;
    text-transform:uppercase;
    letter-spacing:.03em;
    margin:0 0 10px;
}
.bs-analysis-report .raw pre{
    background:#282c34;
    color:#abb2bf;
    padding:18px;
    border-radius:10px;
    overflow-x:auto;
    font-size:12.5px;
    line-height:1.5;
    margin:0;
}
.bs-analysis-report .footer{
    background:#fafafa;
    border-top:1px solid #ececec;
    text-align:center;
    padding:25px;
    color:#777;
    font-size:13px;
}
.bs-analysis-report .footer strong{color:#ff4b4b}
</style>

<div class="raw">
<h2>Analysis JSON</h2>
<pre>${escapeHtml(JSON.stringify(rawData, null, 2))}</pre>
</div>

<div class="container">

<div class="header">
    <div class="title">
        <h1>Bhoomi Suvidha Evaluation Report</h1>
        <p>
            Investment Promotion &amp; Facilitation Agency<br>
            Government of Uttar Pradesh
        </p>
    </div>
</div>

<div class="company">
    <div class="company-name">${escapeHtml(title)}</div>
    <div class="company-sub">AI Based Evaluation Summary</div>
</div>

<div class="overall">
    <h2>${overallTitle}</h2>
    <p>${escapeHtml(overallNote)}</p>

    <div class="summary">
        <div class="pass">✔ Passed : ${passedCount}</div>
        <div class="flag">⚠ Flagged : ${flaggedCount}</div>
        <div class="pending">◌ Pending : ${pendingCount}</div>
    </div>
</div>

<div class="section">
<table>
<thead>
<tr>
<th>Stage</th>
<th>Validation</th>
<th>Status</th>
<th>Remarks</th>
</tr>
</thead>

<tbody>
${stages.map(stageRow).join('')}

</tbody>
</table>
</div>

<div class="footer">
Generated by <strong>Bhoomi Suvidha AI Evaluation Engine</strong><br>
Investment Promotion &amp; Facilitation Agency, Government of Uttar Pradesh
</div>

</div>

</div>`;
}
