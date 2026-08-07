'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { login, postDocumentList, listBucketDocuments, contentTypeForExtension, getDownloadUrl, downloadFile, createClaim, requestUploadUrls, uploadFile, findDocumentByJobId, waitForDocumentUpload } = require('./fraudx-client');

function withFetchMock(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
}

test('contentTypeForExtension maps known extensions case-insensitively', () => {
  assert.equal(contentTypeForExtension('pdf'), 'application/pdf');
  assert.equal(contentTypeForExtension('PDF'), 'application/pdf');
  assert.equal(contentTypeForExtension('png'), 'image/png');
  assert.equal(contentTypeForExtension('jpg'), 'image/jpeg');
  assert.equal(contentTypeForExtension('jpeg'), 'image/jpeg');
  assert.equal(contentTypeForExtension('tiff'), 'image/tiff');
  assert.equal(contentTypeForExtension('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('contentTypeForExtension throws on an unrecognized extension', () => {
  assert.throws(() => contentTypeForExtension('xyz'), /No known content type for file extension "xyz"/);
});

test('login extracts token, orgId, and userId from a real-shaped response', async (t) => {
  withFetchMock(t, async (url, opts) => {
    assert.equal(url, 'https://fake.fraudx.test/fraudx/api/public/v1/auth/login');
    assert.deepEqual(JSON.parse(opts.body), { email: 'a@b.com', password: 'secret' });
    return {
      ok: true,
      json: async () => ({
        displayMessage: 'Login successfully',
        response: {
          customer: { userId: 68, lastActiveOrg: 1, memberships: [{ orgId: 1 }] },
          token: 'fake-jwt-token',
        },
      }),
    };
  });
  process.env.FRAUDX_LOGIN_EMAIL = 'a@b.com';
  process.env.FRAUDX_LOGIN_PASSWORD = 'secret';
  t.after(() => {
    delete process.env.FRAUDX_LOGIN_EMAIL;
    delete process.env.FRAUDX_LOGIN_PASSWORD;
  });

  const auth = await login('https://fake.fraudx.test', 5000);
  assert.deepEqual(auth, { token: 'fake-jwt-token', orgId: 1, userId: 68 });
});

test('login throws a clear error when FRAUDX_LOGIN_EMAIL or FRAUDX_LOGIN_PASSWORD is missing', async () => {
  delete process.env.FRAUDX_LOGIN_EMAIL;
  delete process.env.FRAUDX_LOGIN_PASSWORD;
  await assert.rejects(
    () => login('https://fake.fraudx.test', 5000),
    /FRAUDX_LOGIN_EMAIL and FRAUDX_LOGIN_PASSWORD must both be set/
  );
});

test('login throws a clear error on non-2xx', async (t) => {
  withFetchMock(t, async () => ({ ok: false, status: 401, text: async () => 'bad credentials' }));
  process.env.FRAUDX_LOGIN_EMAIL = 'a@b.com';
  process.env.FRAUDX_LOGIN_PASSWORD = 'secret';
  t.after(() => {
    delete process.env.FRAUDX_LOGIN_EMAIL;
    delete process.env.FRAUDX_LOGIN_PASSWORD;
  });
  await assert.rejects(() => login('https://fake.fraudx.test', 5000), /Login failed: 401 bad credentials/);
});

test('login throws a clear error when the response is missing token/orgId/userId', async (t) => {
  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: { customer: {} } }) }));
  process.env.FRAUDX_LOGIN_EMAIL = 'a@b.com';
  process.env.FRAUDX_LOGIN_PASSWORD = 'secret';
  t.after(() => {
    delete process.env.FRAUDX_LOGIN_EMAIL;
    delete process.env.FRAUDX_LOGIN_PASSWORD;
  });
  await assert.rejects(() => login('https://fake.fraudx.test', 5000), /did not contain response\.token/);
});

test('listBucketDocuments filters deleted documents and returns {gxMasterId, fileName, extension}', async (t) => {
  withFetchMock(t, async (url, opts) => {
    assert.equal(url, 'https://fake.fraudx.test/document-processor/api/documents/v1/views/list/31662');
    const body = JSON.parse(opts.body);
    assert.deepEqual(body, { size: 200, sort: [{ column: 'createdAt', sortType: 'ASC' }], page: 0 });
    return {
      ok: true,
      json: async () => ({
        response: {
          content: [
            { gxMasterId: null, fileIsDeleted: true, fileName: 'deleted.pdf', extension: 'pdf', fileMasterId: 1 },
            { gxMasterId: 64609, fileIsDeleted: false, fileName: 'active.pdf', extension: 'pdf', fileMasterId: 2 },
          ],
          page: { size: 200, number: 0, totalElements: 2, totalPages: 1 },
        },
      }),
    };
  });
  const docs = await listBucketDocuments('https://fake.fraudx.test', 31662, { token: 't', orgId: 1, userId: 68 }, 5000);
  assert.deepEqual(docs, [{ gxMasterId: 64609, fileName: 'active.pdf', extension: 'pdf' }]);
});

test('listBucketDocuments throws when an active document has no gxMasterId yet', async (t) => {
  withFetchMock(t, async () => ({
    ok: true,
    json: async () => ({
      response: {
        content: [{ gxMasterId: null, fileIsDeleted: false, fileName: 'pending.pdf', extension: 'pdf', fileMasterId: 3 }],
        page: { size: 200, number: 0, totalElements: 1, totalPages: 1 },
      },
    }),
  }));
  await assert.rejects(
    () => listBucketDocuments('https://fake.fraudx.test', 31662, { token: 't', orgId: 1, userId: 68 }, 5000),
    /has no gxMasterId yet/
  );
});

test('listBucketDocuments throws when the bucket spans more than one page', async (t) => {
  withFetchMock(t, async () => ({
    ok: true,
    json: async () => ({
      response: { content: [], page: { size: 200, number: 0, totalElements: 500, totalPages: 3 } },
    }),
  }));
  await assert.rejects(
    () => listBucketDocuments('https://fake.fraudx.test', 31662, { token: 't', orgId: 1, userId: 68 }, 5000),
    /pagination isn't implemented yet/
  );
});

test('listBucketDocuments throws a clear timeout error', async (t) => {
  withFetchMock(t, async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    throw err;
  });
  await assert.rejects(
    () => listBucketDocuments('https://fake.fraudx.test', 31662, { token: 't', orgId: 1, userId: 68 }, 5000),
    /Listing documents for bucket 31662 timed out after 5000ms/
  );
});

test('getDownloadUrl extracts response.downloadUrl', async (t) => {
  withFetchMock(t, async (url, opts) => {
    assert.equal(url, 'https://fake.fraudx.test/document-processor/api/documents/v1/downloads/presigned-url');
    assert.deepEqual(JSON.parse(opts.body), { gxMasterId: 64609 });
    return { ok: true, json: async () => ({ response: { downloadUrl: 'https://s3.example/fake-url' } }) };
  });
  const url = await getDownloadUrl('https://fake.fraudx.test', 64609, { token: 't', orgId: 1, userId: 68 }, 5000);
  assert.equal(url, 'https://s3.example/fake-url');
});

test('getDownloadUrl throws when response.downloadUrl is missing', async (t) => {
  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: {} }) }));
  await assert.rejects(
    () => getDownloadUrl('https://fake.fraudx.test', 64609, { token: 't', orgId: 1, userId: 68 }, 5000),
    /did not contain response\.downloadUrl/
  );
});

test('downloadFile returns bytes on success and throws on non-2xx', async (t) => {
  withFetchMock(t, async (url) => {
    if (url === 'https://s3.example/ok') {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    }
    return { ok: false, status: 403, text: async () => 'forbidden' };
  });
  const bytes = await downloadFile('https://s3.example/ok', 5000);
  assert.ok(bytes instanceof ArrayBuffer);
  await assert.rejects(() => downloadFile('https://s3.example/bad', 5000), /Downloading file failed: 403 forbidden/);
});

test('createClaim extracts response.bucket.bucketId', async (t) => {
  withFetchMock(t, async (url, opts) => {
    assert.equal(url, 'https://fake.fraudx.test/fraudx/api/v1/claims');
    assert.deepEqual(JSON.parse(opts.body), { bucketName: 'x', claimCategoryId: 23, ingestionModelId: 1, tags: [] });
    return { ok: true, json: async () => ({ response: { bucket: { bucketId: 31804 } } }) };
  });
  const bucketId = await createClaim(
    'https://fake.fraudx.test',
    { token: 't', orgId: 1, userId: 68 },
    { bucketName: 'x', claimCategoryId: 23, ingestionModelId: 1, tags: [] },
    5000
  );
  assert.equal(bucketId, 31804);
});

test('createClaim throws when response.bucket.bucketId is missing', async (t) => {
  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: {} }) }));
  await assert.rejects(
    () => createClaim('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, {}, 5000),
    /did not contain response\.bucket\.bucketId/
  );
});

test('requestUploadUrls sends skipGxProcess:true and returns response.uploads', async (t) => {
  withFetchMock(t, async (url, opts) => {
    assert.equal(url, 'https://fake.fraudx.test/document-processor/api/documents/v2/uploads/direct');
    const body = JSON.parse(opts.body);
    assert.equal(body.skipGxProcess, true);
    assert.equal(body.gxBucketId, 31804);
    assert.deepEqual(body.files, [{ fileName: 'a.pdf', contentType: 'application/pdf' }]);
    return { ok: true, json: async () => ({ response: { uploads: [{ fileName: 'a.pdf', jobId: 1, uploadUrl: 'https://s3.example/put' }] } }) };
  });
  const uploads = await requestUploadUrls(
    'https://fake.fraudx.test',
    { token: 't', orgId: 1, userId: 68 },
    [{ fileName: 'a.pdf', contentType: 'application/pdf' }],
    31804,
    5000
  );
  assert.deepEqual(uploads, [{ fileName: 'a.pdf', jobId: 1, uploadUrl: 'https://s3.example/put' }]);
});

test('requestUploadUrls throws when response.uploads is missing', async (t) => {
  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: {} }) }));
  await assert.rejects(
    () => requestUploadUrls('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, [], 31804, 5000),
    /did not contain response\.uploads/
  );
});

test('uploadFile PUTs with the correct Content-Type and body, throws on non-2xx', async (t) => {
  let capturedOpts;
  withFetchMock(t, async (url, opts) => {
    capturedOpts = opts;
    return url === 'https://s3.example/ok' ? { ok: true } : { ok: false, status: 500, text: async () => 'boom' };
  });
  const bytes = new ArrayBuffer(4);
  await uploadFile('https://s3.example/ok', bytes, 'application/pdf', 5000);
  assert.equal(capturedOpts.method, 'PUT');
  assert.equal(capturedOpts.headers['Content-Type'], 'application/pdf');
  assert.equal(capturedOpts.body, bytes);
  await assert.rejects(() => uploadFile('https://s3.example/bad', bytes, 'application/pdf', 5000), /Uploading file failed: 500 boom/);
});

test('findDocumentByJobId returns the single match, null if none, throws if more than one', async (t) => {
  let callCount = 0;
  withFetchMock(t, async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.criteria, [{ column: 'jobId', operator: 'EQUALS', values: [callCount === 3 ? 999 : 1] }]);
    if (callCount === 1) return { ok: true, json: async () => ({ response: { content: [{ jobId: 1, status: 'Completed' }], page: {} } }) };
    if (callCount === 2) return { ok: true, json: async () => ({ response: { content: [], page: {} } }) };
    return { ok: true, json: async () => ({ response: { content: [{ jobId: 999 }, { jobId: 999 }], page: {} } }) };
  });
  const found = await findDocumentByJobId('https://fake.fraudx.test', 31804, 1, { token: 't', orgId: 1, userId: 68 }, 5000);
  assert.deepEqual(found, { jobId: 1, status: 'Completed' });
  const notFound = await findDocumentByJobId('https://fake.fraudx.test', 31804, 1, { token: 't', orgId: 1, userId: 68 }, 5000);
  assert.equal(notFound, null);
  await assert.rejects(
    () => findDocumentByJobId('https://fake.fraudx.test', 31804, 999, { token: 't', orgId: 1, userId: 68 }, 5000),
    /Expected at most one document for jobId 999/
  );
});

test('waitForDocumentUpload polls until Completed, throws on error, throws on poll timeout', async (t) => {
  let calls = 0;
  withFetchMock(t, async () => {
    calls++;
    if (calls <= 2) return { ok: true, json: async () => ({ response: { content: [{ jobId: 1, status: 'Processing', error: null }], page: {} } }) };
    return { ok: true, json: async () => ({ response: { content: [{ jobId: 1, status: 'Completed', error: null }], page: {} } }) };
  });
  const doc = await waitForDocumentUpload(
    'https://fake.fraudx.test',
    31804,
    1,
    { token: 't', orgId: 1, userId: 68 },
    5000,
    { pollIntervalMs: 1, pollTimeoutMs: 5000 }
  );
  assert.equal(doc.status, 'Completed');
  assert.equal(calls, 3);

  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: { content: [{ jobId: 2, status: 'Failed', error: 'bad file' }], page: {} } }) }));
  await assert.rejects(
    () => waitForDocumentUpload('https://fake.fraudx.test', 31804, 2, { token: 't', orgId: 1, userId: 68 }, 5000, { pollIntervalMs: 1, pollTimeoutMs: 5000 }),
    /Upload for jobId 2 in bucket 31804 failed: bad file/
  );

  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: { content: [{ jobId: 3, status: 'Processing', error: null }], page: {} } }) }));
  await assert.rejects(
    () => waitForDocumentUpload('https://fake.fraudx.test', 31804, 3, { token: 't', orgId: 1, userId: 68 }, 5000, { pollIntervalMs: 1, pollTimeoutMs: 5 }),
    /did not reach Completed status within 5ms/
  );
});
