'use strict';

const fraudxClient = require('./fraudx-client');
const { extractCitedFileNamesFromText } = require('./scripts/extract-cited-file-names');

const DOCUMENT_TEXT_CHAR_LIMIT = 15000;

function extractCitedFileNames(report) {
  const fileNames = [];
  const seen = new Set();
  for (const q of report.questions) {
    for (const fileName of extractCitedFileNamesFromText(q.answer)) {
      if (!seen.has(fileName)) {
        seen.add(fileName);
        fileNames.push(fileName);
      }
    }
  }
  return fileNames;
}

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

    const citedFileNames = extractCitedFileNames(report);
    const citedDocumentsText = {};
    for (const fileName of citedFileNames) {
      const citedDoc = sourceDocs.find((d) => d.fileName === fileName);
      if (!citedDoc) {
        continue; // the real report cited a file we don't recognize — skip, don't fail the run
      }
      const citedDownloadUrl = await fraudxClient.getDownloadUrl(base, citedDoc.gxMasterId, auth, timeoutMs);
      const citedBytes = await fraudxClient.downloadFile(citedDownloadUrl, timeoutMs);
      const text = await fraudxClient.extractPdfText(citedBytes);
      citedDocumentsText[fileName] = text.slice(0, DOCUMENT_TEXT_CHAR_LIMIT);
    }

    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
        report,
        citedDocumentsText,
      },
    };
  }
}

module.exports = FraudXClaimProvider;
module.exports.extractCitedFileNames = extractCitedFileNames;
