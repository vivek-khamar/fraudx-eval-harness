'use strict';

const { PDFParse } = require('pdf-parse');

const EXTENSION_CONTENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const FETCH_RETRY_ATTEMPTS = 2;

async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      const isTransientNetworkError = !isTimeout && err instanceof TypeError;
      if (!isTransientNetworkError || attempt >= FETCH_RETRY_ATTEMPTS) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

function contentTypeForExtension(extension) {
  const contentType = EXTENSION_CONTENT_TYPES[extension.toLowerCase()];
  if (!contentType) {
    throw new Error(`No known content type for file extension "${extension}" — add it to EXTENSION_CONTENT_TYPES`);
  }
  return contentType;
}

async function extractPdfText(bytes) {
  const parser = new PDFParse({ data: Buffer.from(bytes) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function login(base, timeoutMs) {
  const email = process.env.FRAUDX_LOGIN_EMAIL;
  const password = process.env.FRAUDX_LOGIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'FRAUDX_LOGIN_EMAIL and FRAUDX_LOGIN_PASSWORD must both be set. Copy .env.example to .env and fill it in.'
    );
  }

  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/public/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Login timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const token = body?.response?.token;
  const orgId = body?.response?.customer?.lastActiveOrg;
  const userId = body?.response?.customer?.userId;
  if (!token || orgId == null || userId == null) {
    throw new Error(
      'Login response did not contain response.token / response.customer.lastActiveOrg / response.customer.userId — check the FraudX auth API response shape'
    );
  }
  return { token, orgId, userId };
}

async function postDocumentList(base, bucketId, requestBody, auth, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/document-processor/api/documents/v1/views/list/${bucketId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Listing documents for bucket ${bucketId} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Listing documents for bucket ${bucketId} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.response;
}

async function listBucketDocuments(base, bucketId, auth, timeoutMs) {
  const pageSize = 200;
  const { content, page } = await postDocumentList(
    base,
    bucketId,
    { size: pageSize, sort: [{ column: 'createdAt', sortType: 'ASC' }], page: 0 },
    auth,
    timeoutMs
  );
  if (page.totalPages > 1) {
    throw new Error(
      `Bucket ${bucketId} has ${page.totalElements} documents across ${page.totalPages} pages (page size ${pageSize}) — pagination isn't implemented yet`
    );
  }

  const activeDocs = content.filter((doc) => !doc.fileIsDeleted);
  const missingGxId = activeDocs.find((doc) => doc.gxMasterId == null);
  if (missingGxId) {
    throw new Error(
      `Document "${missingGxId.fileName}" (fileMasterId ${missingGxId.fileMasterId}) in bucket ${bucketId} has no gxMasterId yet — it may still be processing`
    );
  }

  return activeDocs.map((doc) => ({ gxMasterId: doc.gxMasterId, fileName: doc.fileName, extension: doc.extension }));
}

async function getDownloadUrl(base, gxMasterId, auth, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/document-processor/api/documents/v1/downloads/presigned-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify({ gxMasterId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Getting a download URL for gxMasterId ${gxMasterId} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Getting a download URL for gxMasterId ${gxMasterId} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const downloadUrl = body?.response?.downloadUrl;
  if (!downloadUrl) {
    throw new Error(`Presigned-url response for gxMasterId ${gxMasterId} did not contain response.downloadUrl`);
  }
  return downloadUrl;
}

async function downloadFile(url, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Downloading file timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Downloading file failed: ${res.status} ${await res.text()}`);
  }
  return res.arrayBuffer();
}

async function createClaim(base, auth, claimConfig, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/v1/claims`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify(claimConfig),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Creating a claim timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Creating a claim failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const bucketId = body?.response?.bucket?.bucketId;
  if (bucketId == null) {
    throw new Error('Create-claim response did not contain response.bucket.bucketId');
  }
  return bucketId;
}

async function requestUploadUrls(base, auth, files, newBucketId, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/document-processor/api/documents/v2/uploads/direct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify({ files, gxBucketId: newBucketId, skipGxProcess: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Requesting upload URLs for bucket ${newBucketId} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Requesting upload URLs for bucket ${newBucketId} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const uploads = body?.response?.uploads;
  if (!uploads) {
    throw new Error(`Upload-URL response for bucket ${newBucketId} did not contain response.uploads`);
  }
  return uploads;
}

async function uploadFile(uploadUrl, bytes, contentType, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Uploading file timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Uploading file failed: ${res.status} ${await res.text()}`);
  }
}

async function triggerJobProcessing(base, auth, jobIds, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/document-processor/api/documents/v2/jobs/trigger-processing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify({ jobIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Triggering job processing for jobIds [${jobIds}] timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Triggering job processing for jobIds [${jobIds}] failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const returnedJobIds = body?.response?.jobIds;
  if (!returnedJobIds) {
    throw new Error(`Trigger-job-processing response for jobIds [${jobIds}] did not contain response.jobIds`);
  }
  return returnedJobIds;
}

async function findDocumentByJobId(base, bucketId, jobId, auth, timeoutMs) {
  const { content } = await postDocumentList(
    base,
    bucketId,
    { size: 50, criteria: [{ column: 'jobId', operator: 'EQUALS', values: [jobId] }], sort: [{ column: 'createdAt', sortType: 'ASC' }], page: 0 },
    auth,
    timeoutMs
  );
  if (content.length > 1) {
    throw new Error(`Expected at most one document for jobId ${jobId} in bucket ${bucketId}, got ${content.length}`);
  }
  return content[0] || null;
}

async function waitForDocumentUpload(base, bucketId, jobId, auth, timeoutMs, { pollIntervalMs, pollTimeoutMs }) {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const doc = await findDocumentByJobId(base, bucketId, jobId, auth, timeoutMs);
    if (doc?.error) {
      throw new Error(`Upload for jobId ${jobId} in bucket ${bucketId} failed: ${doc.error}`);
    }
    if (doc?.status === 'Completed' || doc?.status === 'Skipped') {
      return doc;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Upload for jobId ${jobId} in bucket ${bucketId} did not reach Completed/Skipped status within ${pollTimeoutMs}ms (last seen status: ${doc ? doc.status : 'not found yet'})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function listGxBuckets(base, auth, requestBody, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/v1/gx-bucket/list-buckets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Listing gx-buckets timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Listing gx-buckets failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.response;
}

async function getBucketDetails(base, bucketId, auth, timeoutMs) {
  const { content } = await listGxBuckets(
    base,
    auth,
    {
      page: 0,
      size: 50,
      sort: [{ column: 'bucketId', sortType: 'DESC' }],
      criteriaOperator: 'AND',
      criteria: [{ column: 'bucketId', operator: 'IN', values: [String(bucketId)] }],
    },
    timeoutMs
  );
  if (content.length !== 1) {
    throw new Error(`Expected exactly one bucket for bucketId ${bucketId}, got ${content.length}`);
  }
  return content[0];
}

async function triggerClaimProcessing(base, auth, bucketId, processingModelId, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/v1/claims/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify({ bucketId, processingModelId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Triggering claim processing for bucket ${bucketId} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Triggering claim processing for bucket ${bucketId} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const taskId = body?.response?.taskId;
  if (!taskId) {
    throw new Error(`Trigger-processing response for bucket ${bucketId} did not contain response.taskId`);
  }
  return taskId;
}

async function waitForClaimProcessing(base, bucketId, auth, timeoutMs, { pollIntervalMs, pollTimeoutMs }) {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const bucket = await getBucketDetails(base, bucketId, auth, timeoutMs);
    if (bucket.bucketStatus === 'SUCCESS') {
      return bucket;
    }
    if (bucket.bucketStatus === 'FAILED') {
      throw new Error(`Claim processing for bucket ${bucketId} failed (bucketStatus: FAILED)`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Claim processing for bucket ${bucketId} did not reach SUCCESS within ${pollTimeoutMs}ms (last seen bucketStatus: ${bucket.bucketStatus})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function fetchReport(base, reportId, auth, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/v1/dashboard/reports/${reportId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Fetching report ${reportId} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Fetching report ${reportId} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body?.response) {
    throw new Error(`Report response for ${reportId} did not contain response`);
  }
  return body.response;
}

async function searchModels(base, auth, typeName, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/v1/models/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify({
        page: 0,
        size: 10000,
        criteriaOperator: 'AND',
        criteria: [{ column: 'types.name', operator: 'EQUALS', values: [typeName] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Searching models for type ${typeName} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Searching models for type ${typeName} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const content = body?.response?.content;
  if (!Array.isArray(content)) {
    throw new Error(`Models-search response for type ${typeName} did not contain response.content`);
  }
  return content;
}

module.exports = {
  login,
  postDocumentList,
  listBucketDocuments,
  contentTypeForExtension,
  extractPdfText,
  getDownloadUrl,
  downloadFile,
  createClaim,
  requestUploadUrls,
  uploadFile,
  triggerJobProcessing,
  findDocumentByJobId,
  waitForDocumentUpload,
  listGxBuckets,
  getBucketDetails,
  triggerClaimProcessing,
  waitForClaimProcessing,
  fetchReport,
  searchModels,
};
