'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promptfoo = require('promptfoo');
const qaMatchAssertion = require('./qa-match-assertion');
const { computeRiskStatusMatch, buildQuestionGradingPrompt, parseGraderVerdict } = require('./qa-match-assertion');

test('computeRiskStatusMatch returns the fraction of matching risk determinations', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' },
    { predefinedQuestionId: 2, expectedRiskStatus: 'UNSURE' },
    { predefinedQuestionId: 3, expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED' },
      ],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 2 / 3);
});

test('computeRiskStatusMatch returns 0 for a question missing from the real report entirely', () => {
  const expectedQa = [{ predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' }];
  const output = { report: { questions: [] } };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 0);
});

test('buildQuestionGradingPrompt embeds the question, expected answer, and actual answer', () => {
  const question = { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' };
  const prompt = buildQuestionGradingPrompt(question, 'Yes, doc X confirms it.');

  assert.match(prompt, /Is there fraud\?/);
  assert.match(prompt, /Yes, per doc X\./);
  assert.match(prompt, /Yes, doc X confirms it\./);
  assert.match(prompt, /"matches": boolean, "reason": string/);
});

test('parseGraderVerdict parses a clean JSON response', () => {
  const result = parseGraderVerdict('{"matches": true, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches' });
});

test('parseGraderVerdict extracts JSON even when wrapped in markdown code fences', () => {
  const response = '```json\n{"matches": false, "reason": "no match"}\n```';
  assert.deepEqual(parseGraderVerdict(response), { matches: false, reason: 'no match' });
});

test('parseGraderVerdict throws a clear error when no JSON object is present', () => {
  assert.throws(() => parseGraderVerdict('not json at all'), /Could not find a JSON object/);
});

test('parseGraderVerdict throws a clear error when matches or reason fields are missing or the wrong type', () => {
  assert.throws(() => parseGraderVerdict('{"matches": "yes", "reason": "ok"}'), /missing matches\/reason fields/);
  assert.throws(() => parseGraderVerdict('{"matches": true}'), /missing matches\/reason fields/);
});

function mockLoadApiProvider(t, callApiImpl) {
  const original = promptfoo.loadApiProvider;
  assert.equal(typeof original, 'function', 'mock target must already exist — loadApiProvider moved or was renamed');
  promptfoo.loadApiProvider = async () => ({ callApi: callApiImpl });
  t.after(() => {
    promptfoo.loadApiProvider = original;
  });
}

function fakeContext(overrides) {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED' },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE' },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' },
        ],
      },
    },
    test: { assert: [{ metric: 'qa_match' }], options: { provider: 'anthropic:messages:claude-sonnet-4-5' } },
    ...overrides,
  };
}

function fakeOutput() {
  return {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED', answer: 'ans2' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED', answer: 'ans3' },
      ],
    },
  };
}

test('qaMatchAssertion combines riskStatusMatch and answerContentMatch into namedScores and an averaged score, calling the grader once per question', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async () => {
    callCount += 1;
    const matches = callCount !== 3; // third question mismatches
    return { output: JSON.stringify({ matches, reason: `reason ${callCount}` }) };
  });

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(callCount, 3); // one call per question, not one batched call
  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
  assert.equal(result.namedScores.answerContentMatch, 2 / 3);
  assert.equal(result.score, (2 / 3 + 2 / 3) / 2);
  assert.equal(result.pass, true);
});

test('qaMatchAssertion returns one perQuestionBreakdown entry per question', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown.length, 3);
  assert.deepEqual(result.perQuestionBreakdown[0], {
    predefinedQuestionId: 1,
    question: 'Q1?',
    actualAnswer: 'ans1',
    riskStatus: 'RISK_DETECTED',
    matches: true,
    reason: 'looks right',
  });
});

test('qaMatchAssertion grades a missing actual answer as NO ANSWER PROVIDED', async (t) => {
  let capturedPrompt;
  mockLoadApiProvider(t, async (prompt) => {
    capturedPrompt = prompt;
    return { output: JSON.stringify({ matches: false, reason: 'no answer' }) };
  });

  const output = { report: { questions: [] } }; // no actual answers exist at all
  await qaMatchAssertion(output, fakeContext());

  assert.match(capturedPrompt, /NO ANSWER PROVIDED/);
});

test('qaMatchAssertion fails when score is below an explicit threshold on the qa_match assert entry', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: false, reason: 'low' }) }));

  const context = fakeContext({ test: { assert: [{ metric: 'qa_match', threshold: 0.9 }], options: {} } });
  const result = await qaMatchAssertion(fakeOutput(), context);

  // riskStatusMatch = 2/3, answerContentMatch = 0, score = (2/3 + 0) / 2 = 1/3, below threshold 0.9
  assert.equal(result.pass, false);
});

test('qaMatchAssertion propagates an error thrown by the grader provider instead of swallowing it', async (t) => {
  mockLoadApiProvider(t, async () => {
    throw new Error('grader provider timed out');
  });

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /grader provider timed out/);
});

test('qaMatchAssertion propagates a response.error from the grader provider', async (t) => {
  mockLoadApiProvider(t, async () => ({ error: 'rate limited' }));

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /rate limited/);
});

test('qaMatchAssertion propagates a parse error when the grader response has no JSON object', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: 'not json at all' }));

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /Could not find a JSON object/);
});
