'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { buildTestsVars, generateTestsVars } = require('./generate-tests-vars');

function sampleClaim(overrides) {
  return {
    claimId: 'FX-GOLD-5K-v1',
    bucketId: 31662,
    newClaimName: 'promptfoo-golden-claim-eval',
    claimCategoryId: 23,
    ingestionModelId: 1,
    processingModelId: 9,
    tags: [{ tagId: 3, tagValueId: 17 }],
    summary: 'Gold summary.',
    questions: [
      {
        id: 1480,
        question: "Are any of the plaintiff's attorneys included in the list of attorneys bad actors?",
        expectedAnswer: 'Yes.',
        expectedRiskStatus: 'RISK_DETECTED',
        expectedCitations: ['logo.pdf'],
      },
    ],
    ...overrides,
  };
}

test('buildTestsVars maps a flat claim into promptfoo test-case shape', () => {
  const result = buildTestsVars([sampleClaim()]);
  assert.deepEqual(result, [
    {
      vars: {
        claimId: 'FX-GOLD-5K-v1',
        bucket: {
          sourceBucketId: 31662,
          newClaim: {
            bucketName: 'promptfoo-golden-claim-eval',
            claimCategoryId: 23,
            ingestionModelId: 1,
            processingModelId: 9,
            tags: [{ tagId: 3, tagValueId: 17 }],
          },
        },
        expected: {
          summarySynopsis: 'Gold summary.',
          qa: [
            {
              predefinedQuestionId: 1480,
              question: "Are any of the plaintiff's attorneys included in the list of attorneys bad actors?",
              expectedAnswerSummary: 'Yes.',
              expectedRiskStatus: 'RISK_DETECTED',
              expectedCitationFileNames: ['logo.pdf'],
            },
          ],
        },
      },
    },
  ]);
});

test('buildTestsVars maps multiple claims in order', () => {
  const result = buildTestsVars([sampleClaim({ claimId: 'A' }), sampleClaim({ claimId: 'B' })]);
  assert.deepEqual(result.map((t) => t.vars.claimId), ['A', 'B']);
});

test('buildTestsVars throws a clear error when the input is not an array', () => {
  assert.throws(() => buildTestsVars({ claimId: 'x' }), /testdata\/claims\.json must contain an array of claim objects/);
});

test('generateTestsVars reads claims.json and writes a re-parseable tests.vars.yaml', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-tests-vars-'));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const outputPath = path.join(tmpDir, 'tests.vars.yaml');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(claimsPath, JSON.stringify([sampleClaim(), sampleClaim({ claimId: 'SECOND' })]));
  generateTestsVars(claimsPath, outputPath);

  const written = yaml.load(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(written.length, 2);
  assert.equal(written[0].vars.claimId, 'FX-GOLD-5K-v1');
  assert.equal(written[1].vars.claimId, 'SECOND');
});

test('generateTestsVars output file starts with a do-not-edit header', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-tests-vars-'));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const outputPath = path.join(tmpDir, 'tests.vars.yaml');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(claimsPath, JSON.stringify([sampleClaim()]));
  generateTestsVars(claimsPath, outputPath);

  const contents = fs.readFileSync(outputPath, 'utf8');
  assert.match(contents, /^# GENERATED FILE/);
});
