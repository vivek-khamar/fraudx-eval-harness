'use strict';

const fraudxClient = require('./fraudx-client');

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

    const filesForUpload = sourceDocs.map((d) => ({
      fileName: d.fileName,
      contentType: fraudxClient.contentTypeForExtension(d.extension),
    }));
    const uploads = await fraudxClient.requestUploadUrls(base, auth, filesForUpload, newBucketId, timeoutMs);

    const uploadPollConfig = {
      pollIntervalMs: Number(process.env.FRAUDX_UPLOAD_POLL_INTERVAL_MS || 2000),
      pollTimeoutMs: Number(process.env.FRAUDX_UPLOAD_POLL_TIMEOUT_MS || 120000),
    };
    for (const doc of sourceDocs) {
      const downloadUrl = await fraudxClient.getDownloadUrl(base, doc.gxMasterId, auth, timeoutMs);
      const bytes = await fraudxClient.downloadFile(downloadUrl, timeoutMs);
      const upload = uploads.find((u) => u.fileName === doc.fileName);
      if (!upload) {
        throw new Error(`No upload URL returned for file "${doc.fileName}"`);
      }
      const contentType = fraudxClient.contentTypeForExtension(doc.extension);
      await fraudxClient.uploadFile(upload.uploadUrl, bytes, contentType, timeoutMs);
      await fraudxClient.waitForDocumentUpload(base, newBucketId, upload.jobId, auth, timeoutMs, uploadPollConfig);
    }

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
        ingestion: { timeMs: processingTimeMs },
        processing: { timeMs: processingTimeMs },
        report,
      },
    };
  }
}

module.exports = FraudXClaimProvider;
