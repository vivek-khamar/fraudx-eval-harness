'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function buildTestsVars(claims) {
  if (!Array.isArray(claims)) {
    throw new Error('claimsdata/claims.json must contain an array of claim objects');
  }
  return claims.map((claim) => ({
    vars: {
      bucket: {
        sourceBucketId: claim.bucketId,
        newClaim: {
          bucketName: claim.newClaimName,
          claimCategoryId: claim.claimCategoryId,
          ingestionModelId: claim.ingestionModelId,
          processingModelId: claim.processingModelId,
          tags: claim.tags,
        },
      },
      expected: {
        summarySynopsis: claim.summary,
        fraudRiskScore: claim.expectedFraudRiskScore,
        claimantName: claim.expectedClaimantName,
        defendant: claim.expectedDefendant,
        insuranceFirm: claim.expectedInsuranceFirm,
        qa: claim.questions.map((q) => ({
          predefinedQuestionId: q.id,
          question: q.question,
          expectedAnswerSummary: q.expectedAnswer,
          expectedRiskStatus: q.expectedRiskStatus,
          expectedChunkText: q.expectedChunkText,
        })),
      },
    },
  }));
}

function generateTestsVars(claimsPath, outputPath) {
  const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  const testCases = buildTestsVars(claims);
  const header = [
    '# GENERATED FILE — do not edit directly.',
    `# Generated from ${path.relative(path.dirname(outputPath), claimsPath)} by scripts/generate-tests-vars.js.`,
    '# To add or change a golden claim, edit that file and re-run `npm run generate:tests`',
    '# (this also happens automatically before `npm test` / `npm run eval`).',
    '',
    '',
  ].join('\n');
  fs.writeFileSync(outputPath, header + yaml.dump(testCases, { lineWidth: -1 }));
}

function main() {
  const claimsPath = process.argv[2] || path.join(__dirname, '..', 'claimsdata', 'claims.json');
  const outputPath = process.argv[3] || path.join(__dirname, '..', 'tests.vars.yaml');
  generateTestsVars(claimsPath, outputPath);
  console.log(`Generated ${outputPath} from ${claimsPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildTestsVars, generateTestsVars };
