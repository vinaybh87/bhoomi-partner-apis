const baseUrl = (process.env.SMOKE_BASE_URL || 'https://bhoomi-suvidha.kenpath.ai/apis').replace(
  /\/$/,
  ''
);
const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;
const applicationId =
  process.env.SMOKE_APPLICATION_ID || `deployment-smoke-${new Date().toISOString().replace(/\D/g, '')}`;

if (!username || !password) {
  throw new Error('SMOKE_USERNAME and SMOKE_PASSWORD are required');
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  expectedStatus = 200
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method || 'GET'} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function main(): Promise<void> {
  const auth = await requestJson<{ token: string; token_type: string }>('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      userId: applicationId,
      name: 'Deployment Smoke Test',
    }),
  });
  if (!auth.token || auth.token_type !== 'Bearer') throw new Error('Token response is incomplete');
  console.log('[smoke] token issuance: ok');

  const authorization = { Authorization: `Bearer ${auth.token}` };
  const analysis = await requestJson<{ analysisId: string; applicationId: string; status: string }>(
    '/v1/analysis',
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        applicationId,
        submissionSequence: 1,
        applicant: {
          entityType: 'Private Limited Company',
          companyName: 'Deployment Smoke Test',
        },
        application: {
          username: 'Deployment Smoke Test',
          district: 'Smoke Test',
          industrialArea: 'Smoke Test',
          plotCategory: 'Smoke Test',
          landAreaSqm: 0,
          proposedInvestmentINR: 0,
          proposedLandInvestmentINR: 0,
          proposedBuildingInvestmentINR: 0,
          proposedEmployment: 0,
          sector: 'Smoke Test',
          formData: {},
        },
        documents: [],
      }),
    }
  );
  if (!analysis.analysisId || analysis.applicationId !== applicationId) {
    throw new Error('Analysis response identifiers do not match the request');
  }
  console.log(`[smoke] analysis submission: ok (${analysis.analysisId})`);

  await requestJson(`/v1/analysis/${encodeURIComponent(analysis.analysisId)}`, {
    headers: authorization,
  });
  console.log('[smoke] analysis retrieval: ok');

  const htmlResponse = await fetch(
    `${baseUrl}/v1/analysis/${encodeURIComponent(analysis.analysisId)}?format=html`,
    { headers: authorization, signal: AbortSignal.timeout(30_000) }
  );
  const contentType = htmlResponse.headers.get('content-type') || '';
  if (!htmlResponse.ok || !contentType.includes('text/html') || !(await htmlResponse.text()).trim()) {
    throw new Error('HTML analysis retrieval did not return a non-empty HTML response');
  }
  console.log('[smoke] HTML retrieval: ok');

  const payment = await requestJson<{ applicationId: string; status: boolean }>(
    '/v1/payment-status',
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId, status: false }),
    }
  );
  if (payment.applicationId !== applicationId || payment.status !== false) {
    throw new Error('Payment status response is inconsistent');
  }
  console.log('[smoke] payment update: ok');

  const paymentRead = await requestJson<{ applicationId: string; status: boolean }>(
    `/v1/payment-status/${encodeURIComponent(applicationId)}`,
    { headers: authorization }
  );
  if (paymentRead.applicationId !== applicationId || paymentRead.status !== false) {
    throw new Error('Payment status retrieval is inconsistent');
  }
  console.log('[smoke] payment retrieval: ok');
  console.log(`[smoke] completed for ${applicationId}`);
}

main().catch((error) => {
  console.error('[smoke] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
