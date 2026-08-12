'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

function scoreDashboard(resultsFilePath) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const results = parsed.results.results;
  if (!results || results.length === 0) {
    throw new Error(`No results found in ${resultsFilePath}`);
  }

  return results.map((result) => {
    const bucketId = result.response?.output?.report?.bucketId;
    if (result.error || !result.response?.output || !result.gradingResult?.namedScores) {
      return { bucketId, error: result.error || 'missing response output or grading result' };
    }

    const output = result.response.output;
    const namedScores = result.gradingResult.namedScores;

    const ingestTime = output.ingestion.timeMs / 1000;
    const claimProcTime = output.processing.timeMs / 1000;

    const acc = Math.round(50 * namedScores.qa_match + 50 * namedScores.report_quality);
    if (Number.isNaN(acc)) {
      return { bucketId, error: 'Computed accuracy score is NaN — a named score is missing from the results file' };
    }

    return { bucketId, ingestTime, claimProcTime, acc, entAcc: null };
  });
}

function main() {
  const resultsFilePath = process.argv[2] || path.join(process.cwd(), 'results.json');
  const dashboard = scoreDashboard(resultsFilePath);
  console.log(JSON.stringify(dashboard, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scoreDashboard };
