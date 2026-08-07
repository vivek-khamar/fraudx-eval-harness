'use strict';

const EXTENSION_CONTENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function contentTypeForExtension(extension) {
  const contentType = EXTENSION_CONTENT_TYPES[extension.toLowerCase()];
  if (!contentType) {
    throw new Error(`No known content type for file extension "${extension}" — add it to EXTENSION_CONTENT_TYPES`);
  }
  return contentType;
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
    res = await fetch(`${base}/fraudx/api/public/v1/auth/login`, {
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
    res = await fetch(`${base}/document-processor/api/documents/v1/views/list/${bucketId}`, {
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

module.exports = { login, postDocumentList, listBucketDocuments, contentTypeForExtension };
