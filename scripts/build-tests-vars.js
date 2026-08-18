'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const fraudxClient = require('../src/fraudx-client');
const s3Client = require('../src/s3-client');
const resolveModelId = require('../src/lib/resolve-model-id');
const { extractCitedCitationsFromText } = require('../src/lib/extract-cited-file-names');

// qa-match-assertion.js requires every expectedChunkText entry to match, so an uncapped list
// makes that assertion both slower (one grader call per entry) and stricter than intended —
// a real claim's question can carry dozens of citations. Cap keeps this bounded and matches
// this codebase's existing bounded-truncation style (see DOCUMENT_TEXT_CHAR_LIMIT in src/provider.js).
const MAX_EXPECTED_CHUNKS_PER_QUESTION = 5;

// Pure. Builds this run's one promptfoo test case in exactly the vars shape
// qa-match-assertion.js / metadata-match-assertion.js / provider.js already
// expect today — only how these values are sourced changes, not their shape.
function buildTestsVars({
  sourceBucketId, claimCategoryId, tags, newClaimName,
  ingestionModelId, processingModelId, existingReport, expectedQa,
}) {
  return [{
    vars: {
      bucket: {
        sourceBucketId,
        newClaim: {
          bucketName: newClaimName,
          claimCategoryId,
          ingestionModelId,
          processingModelId,
          ...(tags ? { tags } : {}),
        },
      },
      expected: {
        summarySynopsis: existingReport.summary,
        fraudRiskScore: existingReport.fraudRiskScore,
        claimantName: existingReport.claimantName,
        defendant: existingReport.defendant,
        insuranceFirm: existingReport.insuranceFirm,
        qa: expectedQa,
      },
    },
  }];
}

// Pure. Turns the existing report's own questions into the qa[] shape,
// resolving each question's own cited chunks' TEXT via the existing bucket's
// own S3 grounding file — the exact same citation-resolution approach
// provider.js already uses for the freshly-created bucket's report, just
// pointed at the existing bucket's grounding file instead.
function buildExpectedQa(existingQuestions, existingGroundingData) {
  return existingQuestions.map((q) => {
    const citations = extractCitedCitationsFromText(q.answer);
    const chunkTexts = [];
    if (existingGroundingData) {
      for (const { documentId, chunkId } of citations) {
        const chunkText = existingGroundingData.get(s3Client.chunkKey(documentId, chunkId));
        if (chunkText) chunkTexts.push(chunkText);
      }
    }
    // Dedupe byte-identical chunk texts before capping — same rationale as the
    // `new Set(texts)` dedup src/provider.js applies to citedDocumentsText.
    const expectedChunkText = [...new Set(chunkTexts)].slice(0, MAX_EXPECTED_CHUNKS_PER_QUESTION);
    return {
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      expectedAnswerSummary: q.answer,
      expectedRiskStatus: q.riskStatus,
      ...(expectedChunkText.length > 0 ? { expectedChunkText } : {}),
    };
  });
}

// Async. Fetches everything the pure functions above need from the existing
// bucket: its claimCategoryId/tags (list-buckets), its own already-existing
// report (fetchReport), and its own chunk-grounding data (S3).
async function fetchExistingBucketBaseline(base, sourceBucketId, auth, timeoutMs) {
  const bucket = await fraudxClient.getBucketDetails(base, sourceBucketId, auth, timeoutMs);
  if (bucket.bucketStatus !== 'SUCCESS' || !bucket.latestReportId) {
    throw new Error(
      `Existing bucket ${sourceBucketId} has no completed report ` +
      `(bucketStatus: ${bucket.bucketStatus}) — it can't serve as ground truth.`
    );
  }
  const existingReport = await fraudxClient.fetchReport(base, bucket.latestReportId, auth, timeoutMs);
  if (!Array.isArray(existingReport.questions) || existingReport.questions.length === 0) {
    throw new Error(`Existing bucket ${sourceBucketId}'s report has no questions — it can't serve as ground truth.`);
  }
  // Same local-dry-run escape hatch as provider.js's own grounding fetch — the mock server has
  // no real S3-backed grounding data, and this flow needs no AWS credentials at all when set.
  const existingGroundingData = process.env.SKIP_S3_GROUNDING === 'true'
    ? null
    : await s3Client.fetchChunkGroundingData(sourceBucketId, timeoutMs);
  const tags = Array.isArray(bucket.tags) && bucket.tags.length > 0
    ? bucket.tags.map((t) => ({ tagId: t.tagId, tagValueId: t.tagValueId }))
    : undefined;
  return { claimCategoryId: bucket.claimCategoryId, tags, existingReport, existingGroundingData };
}

async function generateTestsVars(outputPath) {
  const base = process.env.FRAUDX_ENDPOINT_URI;
  if (!base) throw new Error('FRAUDX_ENDPOINT_URI is not set. Copy .env.example to .env and fill it in.');
  const sourceBucketId = Number(process.env.SOURCE_BUCKET_ID);
  if (!process.env.SOURCE_BUCKET_ID || Number.isNaN(sourceBucketId)) {
    throw new Error('SOURCE_BUCKET_ID must be set to an existing, already-processed bucket id.');
  }
  if (!process.env.CLAIM_NAME) {
    throw new Error('CLAIM_NAME must be set to a name for the new claim.');
  }
  const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);
  const auth = await fraudxClient.login(base, timeoutMs);

  const { claimCategoryId, tags, existingReport, existingGroundingData } =
    await fetchExistingBucketBaseline(base, sourceBucketId, auth, timeoutMs);

  const ingestionModelId = await resolveModelId(base, auth, process.env.INGESTION_MODEL_NAME, 'INGESTION', timeoutMs);
  const processingModelId = await resolveModelId(base, auth, process.env.PROCESSING_MODEL_NAME, 'PROCESSING', timeoutMs);

  const expectedQa = buildExpectedQa(existingReport.questions, existingGroundingData);
  const testsVars = buildTestsVars({
    sourceBucketId, claimCategoryId, tags,
    newClaimName: process.env.CLAIM_NAME,
    ingestionModelId, processingModelId,
    existingReport, expectedQa,
  });

  fs.writeFileSync(
    outputPath,
    '# GENERATED FILE — do not hand-edit. Produced by scripts/build-tests-vars.js from a live\n' +
    '# fetch of the existing bucket named by SOURCE_BUCKET_ID.\n' +
    yaml.dump(testsVars)
  );
}

function main() {
  const outputPath = process.argv[2] || path.join(__dirname, '..', 'tests.vars.yaml');
  generateTestsVars(outputPath).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildTestsVars, buildExpectedQa, fetchExistingBucketBaseline, generateTestsVars };
