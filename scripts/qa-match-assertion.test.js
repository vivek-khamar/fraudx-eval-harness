'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promptfoo = require('promptfoo');
const qaMatchAssertion = require('./qa-match-assertion');
const { computeRiskStatusMatch, buildAnswerContentRubric, buildQuestionGradingPrompt, parseGraderVerdict } = require('./qa-match-assertion');

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

test('buildAnswerContentRubric embeds every expected question, its expected answer, and the matching actual answer', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' },
  ];
  const actualQuestions = [{ predefinedQuestionId: 1, answer: 'Yes, doc X confirms it.' }];

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);

  assert.match(rubric, /Is there fraud\?/);
  assert.match(rubric, /Yes, per doc X\./);
  assert.match(rubric, /Yes, doc X confirms it\./);
  assert.match(rubric, /fraction of pairs that match/);
});

test('buildAnswerContentRubric marks a question missing from the actual report as no answer provided', () => {
  const expectedQa = [
    { predefinedQuestionId: 99, question: 'Missing question?', expectedAnswerSummary: 'Some expected answer.' },
  ];
  const actualQuestions = [];

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);

  assert.match(rubric, /NO ANSWER PROVIDED/);
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

function mockMatchesLlmRubric(t, impl) {
  const original = promptfoo.assertions.matchesLlmRubric;
  assert.equal(typeof original, 'function', 'mock target must already exist — matchesLlmRubric moved or was renamed');
  promptfoo.assertions.matchesLlmRubric = impl;
  t.after(() => {
    promptfoo.assertions.matchesLlmRubric = original;
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

test('qaMatchAssertion combines riskStatusMatch and answerContentMatch into namedScores and an averaged score', async (t) => {
  mockMatchesLlmRubric(t, async () => ({ pass: true, score: 0.75, reason: 'llm reason' }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
  assert.equal(result.namedScores.answerContentMatch, 0.75);
  assert.equal(result.score, (2 / 3 + 0.75) / 2);
  assert.equal(result.pass, true); // score > 0, no threshold configured
});

test('qaMatchAssertion passes context.test.options through to matchesLlmRubric as the grading config', async (t) => {
  let capturedGrading;
  mockMatchesLlmRubric(t, async (rubric, llmOutput, grading) => {
    capturedGrading = grading;
    return { pass: true, score: 1, reason: 'ok' };
  });

  await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.deepEqual(capturedGrading, { provider: 'anthropic:messages:claude-sonnet-4-5' });
});

test('qaMatchAssertion fails when score is below an explicit threshold on the qa_match assert entry', async (t) => {
  mockMatchesLlmRubric(t, async () => ({ pass: true, score: 0.1, reason: 'low' }));

  const context = fakeContext({ test: { assert: [{ metric: 'qa_match', threshold: 0.9 }], options: {} } });
  const result = await qaMatchAssertion(fakeOutput(), context);

  // score = (2/3 + 0.1) / 2 ≈ 0.383, below threshold 0.9
  assert.equal(result.pass, false);
});

test('qaMatchAssertion propagates errors from matchesLlmRubric instead of swallowing them', async (t) => {
  mockMatchesLlmRubric(t, async () => {
    throw new Error('grader provider timed out');
  });

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /grader provider timed out/);
});
