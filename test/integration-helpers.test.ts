import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentUrl } from '../src/fetch-document.js';
import { buildSaveAssessmentUrl } from '../src/upsida-assessment.js';
import { renderAssessmentHtml } from '../src/render-assessment-html.js';

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
});
