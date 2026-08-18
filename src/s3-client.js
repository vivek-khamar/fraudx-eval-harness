'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

// The one definition of the chunk-grounding lookup's key format. Exported because the
// producer (this file) and both consumers (provider.js, lib/qa-match-assertion.js)
// have to agree on it exactly — a drift in any one of them wouldn't crash, it would
// silently resolve zero citations everywhere.
function chunkKey(documentId, chunkId) {
  return `${documentId}:${chunkId}`;
}

function buildGroundingLookup(parsed, bucketId) {
  const questionnaire = parsed && parsed.questionnaire;
  if (!Array.isArray(questionnaire)) {
    throw new Error(`Chunk grounding file for bucketId ${bucketId} is missing a "questionnaire" array`);
  }
  const lookup = new Map();
  for (const entry of questionnaire) {
    const sourceRefs = Array.isArray(entry.source_ref) ? entry.source_ref : [];
    for (const ref of sourceRefs) {
      const doc = ref.document || {};
      if (!doc.document_uuid || !doc.chunk_uuid) {
        continue;
      }
      lookup.set(chunkKey(doc.document_uuid, doc.chunk_uuid), ref.chunk_text);
    }
  }
  return lookup;
}

// Reads FraudX's per-claim chunk-grounding file from S3 — a separate artifact
// from the FraudX API itself, containing the exact verbatim chunk text behind
// every citation the real report can make, keyed by (documentId, chunkId)
// pairs that are stable within this one file (unlike documentId/chunkId
// embedded in citation tags, which are per-ingestion and change every run —
// the file itself is regenerated fresh each run too, so this lookup is always
// built from the same run's own data).
async function fetchChunkGroundingData(bucketId, timeoutMs) {
  const bucketName = process.env.AWS_S3_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('AWS_S3_BUCKET_NAME is not set. Copy .env.example to .env and fill it in.');
  }
  const client = new S3Client({});
  let response;
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: `${bucketId}.json` }),
      { abortSignal: AbortSignal.timeout(timeoutMs) }
    );
  } catch (err) {
    // Checked before NoSuchKey — a timeout is a different failure, and the AWS SDK's raw
    // abort error says nothing about which call died or how long it waited.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Fetching the chunk-grounding file for bucketId ${bucketId} timed out after ${timeoutMs}ms`);
    }
    if (err.name === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
  const body = await response.Body.transformToString();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Chunk grounding file for bucketId ${bucketId} is not valid JSON: ${err.message}`);
  }
  return buildGroundingLookup(parsed, bucketId);
}

module.exports = { fetchChunkGroundingData, chunkKey };
