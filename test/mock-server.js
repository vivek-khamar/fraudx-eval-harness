// fraudx-eval-harness/test/mock-server.js
'use strict';

const http = require('node:http');

const PORT = process.env.MOCK_PORT || 4001;
const SOURCE_BUCKET_ID = process.env.SOURCE_BUCKET_ID || '31804';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    let parsedBody = {};
    if (body) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        // Non-JSON body (e.g. the raw file bytes PUT to /mock-upload) — leave parsedBody as {}.
      }
    }

    if (req.method === 'POST' && req.url === '/fraudx/api/public/v1/auth/login') {
      res.writeHead(200);
      res.end(JSON.stringify({
        displayMessage: 'Login successfully',
        response: {
          customer: { email: 'mock@example.com', userId: 1, lastActiveOrg: 1 },
          token: 'mock-jwt-token',
        },
      }));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/document-processor/api/documents/v1/views/list/')) {
      const isJobIdQuery = (parsedBody.criteria || []).some((c) => c.column === 'jobId');
      res.writeHead(200);
      res.end(JSON.stringify({
        displayMessage: 'Document list retrieved successfully.',
        response: {
          content: isJobIdQuery
            ? [{ jobId: parsedBody.criteria[0].values[0], status: 'Completed', error: null, fileName: 'mock.pdf' }]
            : [
                { gxMasterId: 1001, fileIsDeleted: false, fileName: 'mock.pdf', extension: 'pdf', fileMasterId: 1 },
                { gxMasterId: null, fileIsDeleted: true, fileName: 'deleted-mock.pdf', extension: 'pdf', fileMasterId: 2 },
              ],
          page: { size: 200, number: 0, totalElements: 2, totalPages: 1 },
        },
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/document-processor/api/documents/v1/downloads/presigned-url') {
      res.writeHead(200);
      res.end(JSON.stringify({ response: { downloadUrl: `http://localhost:${PORT}/mock-download` } }));
      return;
    }

    if (req.method === 'GET' && req.url === '/mock-download') {
      res.writeHead(200);
      res.end(Buffer.from('mock file bytes'));
      return;
    }

    if (req.method === 'POST' && req.url === '/fraudx/api/v1/models/search') {
      const typeName = ((parsedBody.criteria || [])[0] || {}).values?.[0];
      res.writeHead(200);
      res.end(JSON.stringify({
        response: {
          content: [
            { id: 1, name: 'gpt-4o', displayName: 'mock-ingestion-model', types: [{ id: 1, name: 'INGESTION' }] },
            { id: 9, name: 'gpt-4o', displayName: 'mock-processing-model', types: [{ id: 2, name: 'PROCESSING' }] },
          ].filter((m) => m.types.some((t) => t.name === typeName)),
        },
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/fraudx/api/v1/claims') {
      res.writeHead(200);
      res.end(JSON.stringify({ response: { bucket: { bucketId: 99999, name: parsedBody.bucketName } } }));
      return;
    }

    if (req.method === 'POST' && req.url === '/document-processor/api/documents/v2/uploads/direct') {
      res.writeHead(200);
      res.end(JSON.stringify({
        response: {
          uploads: parsedBody.files.map((f, i) => ({ fileName: f.fileName, jobId: 5000 + i, uploadUrl: `http://localhost:${PORT}/mock-upload` })),
          sessionId: 'mock-session',
        },
      }));
      return;
    }

    if (req.method === 'PUT' && req.url === '/mock-upload') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/document-processor/api/documents/v2/jobs/trigger-processing') {
      res.writeHead(202);
      res.end(JSON.stringify({
        displayMessage: 'Processing started and jobs have been re-queued for execution.',
        response: { jobIds: parsedBody.jobIds, processingJobIds: [] },
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/fraudx/api/v1/claims/process') {
      res.writeHead(200);
      res.end(JSON.stringify({ response: { status: 'PROCESSING', taskId: 'mock-task-id' } }));
      return;
    }

    if (req.method === 'POST' && req.url === '/fraudx/api/v1/gx-bucket/list-buckets') {
      const bucketIdCriterion = (parsedBody.criteria || []).find((c) => c.column === 'bucketId');
      const queriedBucketId = bucketIdCriterion?.values?.[0];
      const isSourceBucket = queriedBucketId === String(SOURCE_BUCKET_ID);

      res.writeHead(200);
      res.end(JSON.stringify({
        response: {
          content: [
            isSourceBucket
              ? {
                  bucketId: 31804,
                  bucketStatus: 'SUCCESS',
                  latestReportId: 'mock-existing-report-id',
                  claimCategoryId: 23,
                  tags: [
                    {
                      tagId: 3,
                      tagKey: 'Client Update',
                      tagStatus: 'ACTIVE',
                      mandatory: true,
                      tagValueId: 17,
                      value: 'Test B',
                    },
                  ],
                }
              : { bucketId: 99999, bucketStatus: 'SUCCESS', latestReportId: 'mock-report-id' },
          ],
        },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/fraudx/api/v1/dashboard/reports/mock-existing-report-id') {
      res.writeHead(200);
      res.end(JSON.stringify({
        response: {
          reportId: 'mock-existing-report-id',
          bucketId: 31804,
          summary: 'Mock existing claim summary.',
          fraudRiskScore: 0.5,
          claimantName: 'Mock Claimant',
          defendant: 'Mock Defendant',
          insuranceFirm: 'Mock Insurance',
          questions: [
            {
              predefinedQuestionId: 1,
              question: 'Mock question?',
              answer: 'Mock existing answer.',
              riskStatus: 'UNSURE',
            },
          ],
        },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/fraudx/api/v1/dashboard/reports/mock-report-id') {
      res.writeHead(200);
      res.end(JSON.stringify({
        response: {
          reportId: 'mock-report-id',
          bucketId: 99999,
          summary: 'Mock claim summary for local dry runs.',
          fraudRiskScore: 0.5,
          claimantName: 'Mock Claimant',
          defendant: 'Mock Defendant',
          insuranceFirm: 'Mock Insurance',
          questions: [
            {
              predefinedQuestionId: 1,
              question: 'Mock question?',
              // documentId/chunkId are required attributes — extractCitedCitationsFromText skips
              // any citation tag missing one, since it can't be resolved against the S3
              // chunk-grounding file. Real reports always emit all three.
              answer: 'Mock answer. <InTextCitation fileName="mock.pdf" documentId="mock-doc-1" chunkId="mock-chunk-1"></InTextCitation>',
              riskStatus: 'UNSURE',
            },
          ],
        },
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

server.listen(PORT, () => {
  console.log(`FraudX mock server listening on http://localhost:${PORT}`);
});

module.exports = { server };
