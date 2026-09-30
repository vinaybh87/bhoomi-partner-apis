import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentUrl } from '../src/fetch-document.js';
import { buildSaveAssessmentUrl } from '../src/upsida-assessment.js';
import { renderAssessmentHtml, type AssessmentHtmlInput } from '../src/render-assessment-html.js';

test('resolveDocumentUrl rewrites only the configured origin', () => {
  const previousFrom = process.env.DOCUMENT_URL_REWRITE_FROM;
  const previousTo = process.env.DOCUMENT_URL_REWRITE_TO;
  process.env.DOCUMENT_URL_REWRITE_FROM = 'http://127.0.0.1:9101';
  process.env.DOCUMENT_URL_REWRITE_TO = 'http://bhoomi-minio:9001';
  try {
    assert.equal(
      resolveDocumentUrl('http://127.0.0.1:9101/api/v1/download-shared-object/token?x=1'),
      'http://bhoomi-minio:9001/api/v1/download-shared-object/token?x=1'
    );
    assert.equal(
      resolveDocumentUrl('https://documents.example.test/report.pdf'),
      'https://documents.example.test/report.pdf'
    );
  } finally {
    if (previousFrom === undefined) delete process.env.DOCUMENT_URL_REWRITE_FROM;
    else process.env.DOCUMENT_URL_REWRITE_FROM = previousFrom;
    if (previousTo === undefined) delete process.env.DOCUMENT_URL_REWRITE_TO;
    else process.env.DOCUMENT_URL_REWRITE_TO = previousTo;
  }
});

test('buildSaveAssessmentUrl sends ServiceNo only as a query parameter', () => {
  assert.equal(
    buildSaveAssessmentUrl('https://upsida.example.test/api/', 'SER/2026 100'),
    'https://upsida.example.test/api/Assessment/SaveAssessment?ServiceNo=SER%2F2026%20100'
  );
});

test('history HTML shows the requested deduplicated project-detail columns', () => {
  const html = renderAssessmentHtml({
    applicationId: 'test',
    aiSuggestedScore: { value: 0, scale: 100, passMark: 50 },
    marksEvaluation: { total: 0, max: 100, passMark: 50, result: 'BELOW_PASS_MARK', parameters: [] },
    comparisons: [], flags: [], summary: {},
    historyVerification: {
      status: 'FOUND', hasAppliedBefore: true, message: 'Prior land allotments found.',
      priorApplications: [{ applicantId: '13845', industryType: 'Electrical panels', landDetails: 332, buildingDetails: 525 }],
    },
  });
  assert.match(html, /Lands allotted for this applicant/);
  assert.match(html, /Applicant ID/);
  assert.match(html, /Industry Type/);
  assert.match(html, /Land Details/);
  assert.match(html, /Building Details/);
  assert.match(html, /13845/);
  const history = html.match(/<details class="section" open><summary><span><span class="title-left">Historical records[\s\S]*?<\/details>/)?.[0];
  assert.ok(history, 'History starts expanded and has an interactive summary');
  assert.match(history, /<table/);
  assert.match(history, /<summary>/);
});

const reportInput: AssessmentHtmlInput = {
  applicationId: 'APP-2026-42',
  applicantName: 'Example Industries',
  generatedAt: '2026-09-30T10:00:00Z',
  aiSuggestedScore: { value: 40, scale: 100, passMark: 60 },
  marksEvaluation: {
    total: 40, max: 100, passMark: 60, result: 'BELOW_PASS_MARK',
    parameters: [{ parameter: 'Employment', score: 5, max: 10, insight: 'Projected employment' }],
  },
  comparisons: [{ label: 'Company name', dpr_value: 'Example Industries', gst_value: 'Example Industries Ltd', note: 'Check legal name' }],
  flags: [
    { check: 'Documents', status: 'Passed', remarks: 'Documents supplied' },
    { check: 'GST', severity: 'verified' },
    { check: 'Address', status: 'Flagged', remarks: 'Address requires review' },
    { check: 'Turnover', severity: 'warning' },
    { check: 'Certificate', status: 'Pending' },
  ],
  summary: { headline: 'Application requires review', narrative: 'Review supporting records.', lean: 'review', strengths: ['Employment potential'], concerns: ['Address mismatch'] },
  mcaVerification: {
    status: 'MOCK', source: 'mca.gov.in (mock)', companyName: 'Example Industries',
    directors: [{ name: 'Sample Director', designation: 'Director' }],
    findings: [{ severity: 'info', title: 'Mock finding', detail: 'Sample record only' }],
  },
};

test('assessment overview counts agree with the displayed checks and preserve report content', () => {
  const html = renderAssessmentHtml(reportInput);
  assert.match(html, /<h1>Example Industries<\/h1>/);
  assert.match(html, /Application ID:<\/strong> APP-2026-42/);
  assert.match(html, /System score<\/dt><dd>40<small> \/ 100/);
  assert.match(html, /Scoring parameters<\/dt><dd>1/);
  assert.match(html, /Checks passed<\/dt><dd class="value-ok">2/);
  assert.match(html, /Checks flagged<\/dt><dd class="value-bad">2/);
  assert.match(html, /Checks pending<\/dt><dd class="value-warn">1/);
  for (const text of ['Employment potential', 'Address mismatch', 'Documents supplied', 'Check legal name', 'Projected employment', 'Pass mark: 60', 'Sample Director', 'Mock finding', 'Sample record only', 'Mock data']) {
    assert.ok(html.includes(text), `Retains ${text}`);
  }
  assert.ok(html.indexOf('MCA Verifications') < html.indexOf('GST Verifications'));
  assert.ok(html.indexOf('Marks evaluation') < html.indexOf('Historical records'));
  assert.doesNotMatch(html, /under (?:e)?valuation|Review.*Confirm Assessment|Senior Evaluator|<button|<script|<details class="section">/i);
  assert.equal(Buffer.from(Buffer.from(html).toString('base64'), 'base64').toString(), html);
});

test('sparse reports distinguish unavailable history from confirmed absence', () => {
  const sparse = { ...reportInput, applicantName: '', comparisons: [], flags: [], mcaVerification: null };
  const html = renderAssessmentHtml(sparse);
  assert.match(html, /<h1>AI Assisted Assessment<\/h1>/);
  assert.match(html, /MCA verification not available/);
  assert.match(html, /History lookup unavailable/);
  assert.match(html, /No comparisons/);
  assert.match(html, /No assessment checks/);
  assert.doesNotMatch(html, /No prior application|Mock data/);
  const noHistory = renderAssessmentHtml({ ...sparse, historyVerification: { status: 'NO_PRIOR_APPLICATION', hasAppliedBefore: false, message: 'No prior application.', priorApplications: [] } });
  assert.match(noHistory, /No prior application/);
  assert.doesNotMatch(noHistory, /History lookup unavailable/);
  const unavailable = renderAssessmentHtml({ ...sparse, historyVerification: { status: 'UNAVAILABLE', hasAppliedBefore: false, message: '', priorApplications: [] } });
  assert.match(unavailable, /History lookup unavailable/);
});

test('report escapes untrusted content across the header and assessment sections', () => {
  const unsafe = '<script>alert("x")</script>';
  const html = renderAssessmentHtml({
    ...reportInput, applicantName: unsafe, applicationId: unsafe,
    summary: { narrative: unsafe, strengths: [unsafe], concerns: [unsafe] },
    flags: [{ check: unsafe, remarks: unsafe }],
    comparisons: [{ label: unsafe, dpr_value: unsafe, gst_value: unsafe, note: unsafe }],
    mcaVerification: { companyName: unsafe, directors: [{ name: unsafe }], findings: [{ title: unsafe, detail: unsafe }] },
    historyVerification: { status: 'FOUND', hasAppliedBefore: true, message: unsafe, priorApplications: [{ applicantId: unsafe, industryType: unsafe, landDetails: unsafe, buildingDetails: unsafe }] },
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});
