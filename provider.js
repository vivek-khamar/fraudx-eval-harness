'use strict';

class FraudXClaimProvider {
  id() {
    return 'fraudx-claim-provider';
  }

  async callApi(prompt, context) {
    const base = process.env.FRAUDX_TEST_ENDPOINT;
    if (!base) {
      throw new Error('FRAUDX_TEST_ENDPOINT is not set. Copy .env.example to .env and fill it in.');
    }

    const { claimId } = context.vars;
    const documentPointers = context.vars.documentIds;
    const docIds = documentPointers.documentIds;
    const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);

    const ingestStart = Date.now();
    let ingestRes;
    try {
      ingestRes = await fetch(`${base}/internal/eval/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId, documentIds: docIds }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`Ingestion timed out after ${timeoutMs}ms for ${claimId}`);
      }
      throw err;
    }
    if (!ingestRes.ok) {
      throw new Error(`Ingestion failed for ${claimId}: ${ingestRes.status} ${await ingestRes.text()}`);
    }
    await ingestRes.json();
    const ingestionTimeMs = Date.now() - ingestStart;

    const processStart = Date.now();
    let processRes;
    try {
      processRes = await fetch(`${base}/internal/eval/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`Processing timed out after ${timeoutMs}ms for ${claimId}`);
      }
      throw err;
    }
    if (!processRes.ok) {
      throw new Error(`Processing failed for ${claimId}: ${processRes.status} ${await processRes.text()}`);
    }
    const processBody = await processRes.json();
    const processingTimeMs = Date.now() - processStart;

    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
        report: processBody.report,
      },
    };
  }
}

module.exports = FraudXClaimProvider;
