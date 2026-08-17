'use strict';

const fraudxClient = require('./fraudx-client');
const s3Client = require('./s3-client');
const { extractCitedCitationsFromText } = require('./scripts/extract-cited-file-names');

const DOCUMENT_TEXT_CHAR_LIMIT = 15000;

class FraudXClaimProvider {
  id() {
    return 'fraudx-claim-provider';
  }

  async callApi(prompt, context) {
    const base = process.env.FRAUDX_ENDPOINT_URI;
    if (!base) {
      throw new Error('FRAUDX_ENDPOINT_URI is not set. Copy .env.example to .env and fill it in.');
    }
    const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);
    const auth = await fraudxClient.login(base, timeoutMs);

    const { sourceBucketId, newClaim } = context.vars.bucket;

    const sourceDocs = await fraudxClient.listBucketDocuments(base, sourceBucketId, auth, timeoutMs);
    const newBucketId = await fraudxClient.createClaim(
      base,
      auth,
      {
        bucketName: newClaim.bucketName,
        claimCategoryId: newClaim.claimCategoryId,
        ingestionModelId: newClaim.ingestionModelId,
        tags: newClaim.tags,
      },
      timeoutMs
    );

    const uploadPollConfig = {
      pollIntervalMs: Number(process.env.FRAUDX_UPLOAD_POLL_INTERVAL_MS || 2000),
      pollTimeoutMs: Number(process.env.FRAUDX_UPLOAD_POLL_TIMEOUT_MS || 3600000),
    };
    const ingestionStart = Date.now();
    await Promise.all(sourceDocs.map(async (doc) => {
      const contentType = fraudxClient.contentTypeForExtension(doc.extension);
      const downloadUrl = await fraudxClient.getDownloadUrl(base, doc.gxMasterId, auth, timeoutMs);
      const bytes = await fraudxClient.downloadFile(downloadUrl, timeoutMs);
      // Requested here, immediately before use, rather than batched for all documents upfront —
      // presigned upload URLs go stale within minutes on the real platform. Each document still
      // requests its own URL right before uploading; only the documents now run concurrently
      // with each other instead of waiting their turn.
      const uploads = await fraudxClient.requestUploadUrls(base, auth, [{ fileName: doc.fileName, contentType }], newBucketId, timeoutMs);
      const upload = uploads.find((u) => u.fileName === doc.fileName);
      if (!upload) {
        throw new Error(`No upload URL returned for file "${doc.fileName}"`);
      }
      await fraudxClient.uploadFile(upload.uploadUrl, bytes, contentType, timeoutMs);
      await fraudxClient.triggerJobProcessing(base, auth, [upload.jobId], timeoutMs);
      await fraudxClient.waitForDocumentUpload(base, newBucketId, upload.jobId, auth, timeoutMs, uploadPollConfig);
    }));
    const ingestionTimeMs = Date.now() - ingestionStart;

    const processingStart = Date.now();
    await fraudxClient.triggerClaimProcessing(base, auth, newBucketId, newClaim.processingModelId, timeoutMs);
    const bucket = await fraudxClient.waitForClaimProcessing(base, newBucketId, auth, timeoutMs, {
      pollIntervalMs: Number(process.env.FRAUDX_PROCESSING_POLL_INTERVAL_MS || 5000),
      pollTimeoutMs: Number(process.env.FRAUDX_PROCESSING_POLL_TIMEOUT_MS || 3600000),
    });
    const processingTimeMs = Date.now() - processingStart;

    const report = await fraudxClient.fetchReport(base, bucket.latestReportId, auth, timeoutMs);

    const citations = report.questions.flatMap((q) => extractCitedCitationsFromText(q.answer));
    // SKIP_S3_GROUNDING=true is the local-dry-run escape hatch (npm run mock-server): the mock
    // server has no real S3-backed grounding data for its fake bucketId, and this flow needs no
    // AWS credentials at all. Skipping lands on exactly the same state as a missing grounding
    // file — chunkGroundingData null, citedDocumentsText {} — never set it in CI/production.
    const skipS3Grounding = process.env.SKIP_S3_GROUNDING === 'true';
    const chunkGroundingData = skipS3Grounding
      ? null
      : await s3Client.fetchChunkGroundingData(report.bucketId, timeoutMs);
    const citedDocumentsText = {};
    if (chunkGroundingData) {
      const chunksByFileName = new Map();
      for (const { fileName, documentId, chunkId } of citations) {
        const chunkText = chunkGroundingData.get(s3Client.chunkKey(documentId, chunkId));
        if (!chunkText) {
          continue; // not found in the grounding file — skip, no fallback
        }
        if (!chunksByFileName.has(fileName)) {
          chunksByFileName.set(fileName, []);
        }
        chunksByFileName.get(fileName).push(chunkText);
      }
      for (const [fileName, texts] of chunksByFileName) {
        // Two questions citing the exact same chunk is intentional and stays intentional —
        // but concatenating that chunk's text twice only spends truncation budget on a
        // literal duplicate, so byte-identical strings collapse to one copy here.
        citedDocumentsText[fileName] = [...new Set(texts)].join('\n\n').slice(0, DOCUMENT_TEXT_CHAR_LIMIT);
      }
    }

    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
        report,
        citedDocumentsText,
        chunkGroundingData,
      },
    };
  }
}

module.exports = FraudXClaimProvider;
