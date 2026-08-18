'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promptfoo = require('promptfoo');
const qaMatchAssertion = require('./qa-match-assertion');
const { computeRiskStatusMatch, buildQuestionGradingPrompt, parseGraderVerdict } = require('./qa-match-assertion');

test('computeRiskStatusMatch returns the fraction of matching risk determinations', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, question: 'Q1?', expectedRiskStatus: 'RISK_DETECTED' },
    { predefinedQuestionId: 2, question: 'Q2?', expectedRiskStatus: 'UNSURE' },
    { predefinedQuestionId: 3, question: 'Q3?', expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED' },
        { predefinedQuestionId: 2, question: 'Q2?', riskStatus: 'RISK_DETECTED' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, question: 'Q3?', riskStatus: 'RISK_DETECTED' },
      ],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 2 / 3);
});

test('computeRiskStatusMatch returns 0 for a question missing from the real report entirely', () => {
  const expectedQa = [{ predefinedQuestionId: 1, question: 'Q1?', expectedRiskStatus: 'RISK_DETECTED' }];
  const output = { report: { questions: [] } };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 0);
});

test('computeRiskStatusMatch matches by question text even when predefinedQuestionId differs between the actual report and golden data (ids are re-minted per claim-processing run, not stable)', () => {
  const expectedQa = [
    { predefinedQuestionId: 113, question: 'Is there evidence of fraud?', expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      // Same question text, but a completely different predefinedQuestionId — as happens
      // when the same claim is re-ingested/re-processed and the platform mints fresh ids.
      questions: [{ predefinedQuestionId: 1625, question: 'Is there evidence of fraud?', riskStatus: 'RISK_DETECTED' }],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 1);
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
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 2, question: 'Q2?', riskStatus: 'RISK_DETECTED', answer: 'ans2' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, question: 'Q3?', riskStatus: 'RISK_DETECTED', answer: 'ans3' },
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
    riskStatusMatches: true,
    matches: true,
    reason: 'looks right',
    actualCitedFileNames: [],
    citationMatches: undefined,
    citationMatchReason: undefined,
  });
});

test('qaMatchAssertion sets riskStatusMatches false per-question when the actual riskStatus differs from expected', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  // Question 2 expects UNSURE but fakeOutput reports RISK_DETECTED — a mismatch.
  assert.equal(result.perQuestionBreakdown[1].riskStatusMatches, false);
  assert.equal(result.perQuestionBreakdown[1].riskStatus, 'RISK_DETECTED');
  // Questions 1 and 3 both expect and get RISK_DETECTED — a match.
  assert.equal(result.perQuestionBreakdown[0].riskStatusMatches, true);
  assert.equal(result.perQuestionBreakdown[2].riskStatusMatches, true);
});

test('qaMatchAssertion matches the actual question by question text, not predefinedQuestionId, since ids are re-minted every claim-processing run', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const context = fakeContext();
  // Golden data was captured from one run; predefinedQuestionId 1 there may not exist at all
  // in a fresh run's report — only the question text is guaranteed to still line up.
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 9001, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 9002, question: 'Q2?', riskStatus: 'RISK_DETECTED', answer: 'ans2' },
        { predefinedQuestionId: 9003, question: 'Q3?', riskStatus: 'RISK_DETECTED', answer: 'ans3' },
      ],
    },
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].actualAnswer, 'ans1');
  assert.notEqual(result.perQuestionBreakdown[0].actualAnswer, 'NO ANSWER PROVIDED');
  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
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

function fakeContextWithExpectedChunkText() {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedChunkText: ['The gold passage about attorney X.'] },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE', expectedChunkText: ['The gold passage about provider Y.'] },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' }, // no expectedChunkText — not graded for citations
        ],
      },
    },
    test: { assert: [{ metric: 'qa_match' }], options: { provider: 'anthropic:messages:claude-sonnet-4-5' } },
  };
}

function fakeOutputWithCitations() {
  return {
    report: {
      questions: [
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
        { predefinedQuestionId: 2, question: 'Q2?', riskStatus: 'UNSURE', answer: 'see <InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>' },
        { predefinedQuestionId: 3, question: 'Q3?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="c.pdf" documentId="doc-3" chunkId="chunk-3"></InTextCitation>' }, // no expectedChunkText — excluded
      ],
    },
    chunkGroundingData: new Map([
      ['doc-1:chunk-1', 'The actual chunk text for attorney X, matching the gold passage.'],
      ['doc-2:chunk-2', 'A completely unrelated chunk about something else.'],
      ['doc-3:chunk-3', 'Text for question 3, irrelevant since ungraded.'],
    ]),
  };
}

// Distinguishes the per-question answer-content grading call (buildQuestionGradingPrompt)
// from the new chunk-text semantic-match call (buildChunkTextMatchPrompt) by prompt
// content, so a single mock can serve both call sites with different canned verdicts.
function isChunkTextMatchPrompt(prompt) {
  return prompt.includes('Expected source passage:');
}

test('qaMatchAssertion computes citationMatch via chunk-text semantic match using output.chunkGroundingData', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      const matches = prompt.includes('attorney X');
      return { output: JSON.stringify({ matches, reason: matches ? 'Chunk supports the passage' : 'Chunk is unrelated' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer content ok' }) };
  });

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'Chunk supports the passage');
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[1].citationMatchReason, 'Chunk is unrelated');
  assert.equal(result.perQuestionBreakdown[2].citationMatches, undefined);
  assert.equal(result.namedScores.citationMatch, 0.5); // 1 of 2 graded questions matched
});

test('qaMatchAssertion treats citing any one of multiple chunks as a match, not requiring all of them', async (t) => {
  let chunkCallCount = 0;
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      chunkCallCount += 1;
      const matches = chunkCallCount === 2; // first cited chunk fails, second matches
      return { output: JSON.stringify({ matches, reason: matches ? 'second chunk matches' : 'first chunk does not match' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'first chunk text');
  output.chunkGroundingData.set('doc-1:chunk-2', 'second chunk text');

  // This test isolates question 1's multi-citation "at least one" behavior. Question 2 is
  // also graded for citations by default (fakeContextWithExpectedChunkText) and its citation
  // always resolves (fakeOutputWithCitations), which would add an uncounted grader call and
  // break the chunkCallCount assertion below — so it's excluded from citation grading here.
  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(chunkCallCount, 2, 'must check both cited chunks before concluding a match');
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'second chunk matches');
});

test('qaMatchAssertion requires EVERY expectedChunkText entry to be supported, not just one, since a question can draw on several distinct source chunks', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      callCount += 1;
      // entry A matches chunk-1 immediately (1 call); entry B fails chunk-1 then matches chunk-2 (2 calls)
      if (callCount === 1) return { output: JSON.stringify({ matches: true, reason: 'entryA matched chunk-1' }) };
      if (callCount === 2) return { output: JSON.stringify({ matches: false, reason: 'entryB does not match chunk-1' }) };
      if (callCount === 3) return { output: JSON.stringify({ matches: true, reason: 'entryB matched chunk-2' }) };
      throw new Error(`unexpected extra chunk-match grader call #${callCount}`);
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'first chunk text');
  output.chunkGroundingData.set('doc-1:chunk-2', 'second chunk text');

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = ['gold passage A', 'gold passage B'];
  context.vars.expected.qa[1].expectedChunkText = undefined; // isolate question 1's call count

  const result = await qaMatchAssertion(output, context);

  assert.equal(callCount, 3, 'entry A resolves in 1 call, entry B in 2 calls');
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion reports citationMatches false when at least one expectedChunkText entry finds no supporting chunk, even though others do', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      callCount += 1;
      // entry A matches chunk-1 immediately; entry B never matches either chunk
      if (callCount === 1) return { output: JSON.stringify({ matches: true, reason: 'entryA matched chunk-1' }) };
      if (callCount === 2) return { output: JSON.stringify({ matches: false, reason: 'entryB does not match chunk-1' }) };
      if (callCount === 3) return { output: JSON.stringify({ matches: false, reason: 'entryB does not match chunk-2' }) };
      throw new Error(`unexpected extra chunk-match grader call #${callCount}`);
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'first chunk text');
  output.chunkGroundingData.set('doc-1:chunk-2', 'second chunk text');

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = ['gold passage A', 'gold passage B'];
  context.vars.expected.qa[1].expectedChunkText = undefined; // isolate question 1's call count

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  // The reason must surface the entry that actually failed, not the one that matched.
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'entryB does not match chunk-2');
});

test('qaMatchAssertion skips a citation whose (documentId, chunkId) is not in chunkGroundingData, without crashing', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called for a citation that never resolved');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = 'see <InTextCitation fileName="missing.pdf" documentId="doc-x" chunkId="chunk-x"></InTextCitation>';
  // doc-x:chunk-x is deliberately absent from chunkGroundingData

  // This test isolates question 1's unresolved-citation behavior. Question 2 is also graded
  // for citations by default (fakeContextWithExpectedChunkText) and its citation always
  // resolves (fakeOutputWithCitations), which would trigger the "must not be called" mock —
  // so it's excluded from citation grading here.
  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(
    result.perQuestionBreakdown[0].citationMatchReason,
    'No cited chunk resolved to compare against the expected passage.'
  );
});

test('qaMatchAssertion treats a null chunkGroundingData (missing S3 file) as every citation unresolved', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called when chunkGroundingData is null');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.chunkGroundingData = null;

  const result = await qaMatchAssertion(output, fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
});

test('qaMatchAssertion sets namedScores.citationMatch to undefined when no question has expectedChunkText', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.namedScores.citationMatch, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
  assert.ok(result.perQuestionBreakdown.every((v) => v.citationMatches === undefined));
  // falls back to the 2-signal average exactly as before this feature existed
  assert.equal(result.score, (result.namedScores.riskStatusMatch + result.namedScores.answerContentMatch) / 2);
});

test('qaMatchAssertion folds citationMatch into its own score as a 3-way average when at least one question is graded for it', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithExpectedChunkText());

  const { riskStatusMatch, answerContentMatch, citationMatch } = result.namedScores;
  assert.equal(result.score, (riskStatusMatch + answerContentMatch + citationMatch) / 3);
});

test('qaMatchAssertion treats an empty-array expectedChunkText as NOT graded for citations', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const context = fakeContext();
  context.vars.expected.qa[0].expectedChunkText = [];

  const result = await qaMatchAssertion(fakeOutput(), context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
});

test('qaMatchAssertion correctly reads expectedChunkText when vars are built by the real build-tests-vars.js pipeline, not hand-authored', async (t) => {
  const { buildTestsVars, buildExpectedQa } = require('../../scripts/build-tests-vars');
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const existingReport = {
    summary: 'S',
    fraudRiskScore: 0.5,
    claimantName: 'X',
    defendant: 'Y',
    insuranceFirm: 'Z',
    questions: [
      { predefinedQuestionId: 1, question: 'Q1?', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>', riskStatus: 'RISK_DETECTED' },
    ],
  };
  const existingGroundingData = new Map([['doc-1:chunk-1', 'gold passage text']]);
  const expectedQa = buildExpectedQa(existingReport.questions, existingGroundingData);
  const [{ vars }] = buildTestsVars({
    sourceBucketId: 1, claimCategoryId: 1, tags: undefined, newClaimName: 'x',
    ingestionModelId: 1, processingModelId: 9, existingReport, expectedQa,
  });
  const context = { vars, test: { assert: [{ metric: 'qa_match' }], options: {} } };
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
      ],
    },
    chunkGroundingData: new Map([['doc-1:chunk-1', 'gold passage text']]),
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.namedScores.citationMatch, 1);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion lists a fileName cited via two different chunks only once in actualCitedFileNames', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  // Citations are deduplicated by (documentId, chunkId), not by fileName — one source document
  // split across two cited chunks is two distinct citations, but still one cited file.
  const output = fakeOutput();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="same.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="same.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');

  const result = await qaMatchAssertion(output, fakeContext());

  assert.deepEqual(result.perQuestionBreakdown[0].actualCitedFileNames, ['same.pdf']);
});
