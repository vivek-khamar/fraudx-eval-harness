'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fraudxClient = require('../fraudx-client');
const resolveModelId = require('./resolve-model-id');

// Mutates the CI runner's LOCAL, EPHEMERAL checkout of testdata/claims.json —
// this is only ever meant to run in a CI job's disposable working copy
// (see the "Ad-hoc claim overrides" note in the CI design spec). It has no
// safeguard against running it against a real local working tree by mistake.
async function applyAdhocClaimOverrides(claimsPath) {
  const newClaimName = process.env.ADHOC_NEW_CLAIM_NAME || '';
  const ingestionModelName = process.env.ADHOC_INGESTION_MODEL_NAME || '';
  const processingModelName = process.env.ADHOC_PROCESSING_MODEL_NAME || '';

  if (!newClaimName && !ingestionModelName && !processingModelName) {
    console.error('No ad-hoc claim overrides requested — leaving testdata/claims.json unchanged.');
    return;
  }

  const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));

  let ingestionModelId;
  let processingModelId;
  if (ingestionModelName || processingModelName) {
    const base = process.env.FRAUDX_ENDPOINT_URI;
    const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);
    const auth = await fraudxClient.login(base, timeoutMs);
    if (ingestionModelName) {
      ingestionModelId = await resolveModelId(base, auth, ingestionModelName, 'INGESTION', timeoutMs);
      console.error(`Resolved ingestion model "${ingestionModelName}" to id ${ingestionModelId}`);
    }
    if (processingModelName) {
      processingModelId = await resolveModelId(base, auth, processingModelName, 'PROCESSING', timeoutMs);
      console.error(`Resolved processing model "${processingModelName}" to id ${processingModelId}`);
    }
  }

  for (const claim of claims) {
    if (newClaimName) {
      claim.newClaimName = newClaimName;
    }
    if (ingestionModelId !== undefined) {
      claim.ingestionModelId = ingestionModelId;
    }
    if (processingModelId !== undefined) {
      claim.processingModelId = processingModelId;
    }
  }

  fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + '\n', 'utf8');
  console.error(`Applied ad-hoc overrides to ${claims.length} claim(s) in ${claimsPath}.`);
}

function main() {
  const claimsPath = process.argv[2] || path.join(__dirname, '..', 'testdata', 'claims.json');
  applyAdhocClaimOverrides(claimsPath).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = { applyAdhocClaimOverrides };
