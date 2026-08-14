'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const fraudxClient = require('../fraudx-client');
const resolveModelId = require('./resolve-model-id');

// testdata/claims.json intentionally ships with no newClaimName/ingestionModelId/
// processingModelId — a claim name can't be reused on the real platform, and the
// ingestion/processing model is a deliberate per-run choice, not a fixed answer-key
// fact. Every eval run, local or CI, must supply CLAIM_NAME/INGESTION_MODEL_NAME/
// PROCESSING_MODEL_NAME and this step resolves+writes them before generate:tests
// reads testdata/claims.json.
async function applyClaimConfig(claimsPath) {
  const claimName = process.env.CLAIM_NAME || '';
  const ingestionModelName = process.env.INGESTION_MODEL_NAME || '';
  const processingModelName = process.env.PROCESSING_MODEL_NAME || '';

  const missing = [];
  if (!claimName) missing.push('CLAIM_NAME');
  if (!ingestionModelName) missing.push('INGESTION_MODEL_NAME');
  if (!processingModelName) missing.push('PROCESSING_MODEL_NAME');
  if (missing.length > 0) {
    throw new Error(`Missing required claim config env var(s): ${missing.join(', ')}`);
  }

  const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));

  const base = process.env.FRAUDX_ENDPOINT_URI;
  const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);
  const auth = await fraudxClient.login(base, timeoutMs);

  const ingestionModelId = await resolveModelId(base, auth, ingestionModelName, 'INGESTION', timeoutMs);
  console.error(`Resolved ingestion model "${ingestionModelName}" to id ${ingestionModelId}`);
  const processingModelId = await resolveModelId(base, auth, processingModelName, 'PROCESSING', timeoutMs);
  console.error(`Resolved processing model "${processingModelName}" to id ${processingModelId}`);

  for (const claim of claims) {
    claim.newClaimName = claimName;
    claim.ingestionModelId = ingestionModelId;
    claim.processingModelId = processingModelId;
  }

  fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + '\n', 'utf8');
  console.error(`Applied claim config to ${claims.length} claim(s) in ${claimsPath}.`);
}

function main() {
  const claimsPath = process.argv[2] || path.join(__dirname, '..', 'testdata', 'claims.json');
  applyClaimConfig(claimsPath).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = { applyClaimConfig };
