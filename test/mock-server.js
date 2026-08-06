// fraudx-claim-eval/test/mock-server.js
'use strict';

const http = require('node:http');

const PORT = process.env.MOCK_PORT || 4001;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/internal/eval/ingest') {
      const { documentIds } = JSON.parse(body || '{}');
      res.writeHead(200);
      res.end(JSON.stringify({ indexedDocumentCount: (documentIds || []).length }));
      return;
    }

    if (req.method === 'POST' && req.url === '/internal/eval/process') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          report: {
            summary:
              '58yo male, prior back surgery, submitted claim for lumbar spine treatment following a workplace injury.',
            qa: [
              { questionId: 'q1_diagnosis', answer: 'Type 2 diabetes mellitus', citation: { documentId: 'doc_0112', page: 4 } },
              { questionId: 'q2_prior_claims', answer: 'Two prior claims in the last 24 months', citation: { documentId: 'doc_0087', page: 1 } },
            ],
          },
        })
      );
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
