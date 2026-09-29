import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentUrl } from '../src/fetch-document.js';
import { buildSaveAssessmentUrl } from '../src/upsida-assessment.js';

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
