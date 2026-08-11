'use strict';

const fraudxClient = require('./fraudx-client');

function extractCitedFileNames(report) {
  const fileNames = new Set();
  const tagRegex = /<InTextCitation\b([^>]*)>/g;
  for (const q of report.questions) {
    let match;
    while ((match = tagRegex.exec(q.answer)) !== null) {
      const fileNameMatch = /fileName="([^"]*)"/.exec(match[1]);
      if (fileNameMatch) {
        fileNames.add(decodeURIComponent(fileNameMatch[1]));
      }
    }
  }
  return [...fileNames];
}

class FraudXClaimProvider {
  id() {
    return 'fraudx-claim-provider';
  }

  async callApi(prompt, context) {
    const base = process.env.FRAUDX_TEST_ENDPOINT;
    if (!base) {
      throw new Error('FRAUDX_TEST_ENDPOINT is not set. Copy .env.example to .env and fill it in.');
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
      pollTimeoutMs: Number(process.env.FRAUDX_UPLOAD_POLL_TIMEOUT_MS || 600000),
    };
    const ingestionStart = Date.now();
    for (const doc of sourceDocs) {
      const contentType = fraudxClient.contentTypeForExtension(doc.extension);
      const downloadUrl = await fraudxClient.getDownloadUrl(base, doc.gxMasterId, auth, timeoutMs);
      const bytes = await fraudxClient.downloadFile(downloadUrl, timeoutMs);
      // Requested here, immediately before use, rather than batched for all documents before the loop —
      // presigned upload URLs go stale within minutes on the real platform, and each document can now
      // take minutes of real GX processing before the next one's turn comes up.
      const uploads = await fraudxClient.requestUploadUrls(base, auth, [{ fileName: doc.fileName, contentType }], newBucketId, timeoutMs);
      const upload = uploads.find((u) => u.fileName === doc.fileName);
      if (!upload) {
        throw new Error(`No upload URL returned for file "${doc.fileName}"`);
      }
      await fraudxClient.uploadFile(upload.uploadUrl, bytes, contentType, timeoutMs);
      await fraudxClient.triggerJobProcessing(base, auth, [upload.jobId], timeoutMs);
      await fraudxClient.waitForDocumentUpload(base, newBucketId, upload.jobId, auth, timeoutMs, uploadPollConfig);
    }
    const ingestionTimeMs = Date.now() - ingestionStart;

    const processingStart = Date.now();
    await fraudxClient.triggerClaimProcessing(base, auth, newBucketId, newClaim.processingModelId, timeoutMs);
    const bucket = await fraudxClient.waitForClaimProcessing(base, newBucketId, auth, timeoutMs, {
      pollIntervalMs: Number(process.env.FRAUDX_PROCESSING_POLL_INTERVAL_MS || 5000),
      pollTimeoutMs: Number(process.env.FRAUDX_PROCESSING_POLL_TIMEOUT_MS || 900000),
    });
    const processingTimeMs = Date.now() - processingStart;

    const report = await fraudxClient.fetchReport(base, bucket.latestReportId, auth, timeoutMs);

    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
        report,
      },
    };
  }
}

module.exports = FraudXClaimProvider;
module.exports.extractCitedFileNames = extractCitedFileNames;
