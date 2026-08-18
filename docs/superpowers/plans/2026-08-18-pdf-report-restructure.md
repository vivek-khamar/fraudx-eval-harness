# PDF Report Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `scripts/generate-pdf-report.js`'s PDF output into two explicit sections (Document Ingestion, Claim Processing), add a compact stat-card grid for headline numbers, turn the per-question breakdown into a real bordered table with a new per-question numeric score, and clean up citation-link formatting in answers.

**Architecture:** Add two small, independently-testable building blocks first (a stat-card-row renderer in `scripts/generate-pdf-report.js`, a citation-to-`[n]`-marker formatter in `src/lib/extract-cited-file-names.js`), plumb a new per-question numeric `score` through the grader (`src/lib/qa-match-assertion.js`) and new ingestion counts through the provider (`src/provider.js`), then rewrite `renderClaimPdf` to assemble everything into the two-section layout. Finish with a full-suite + manual-PDF verification pass.

**Tech Stack:** pdfkit (existing dependency, no new packages), `pdf-parse` for PDF-content assertions in tests (existing dev pattern), Node's built-in `node:test`/`node:assert/strict`.

## Global Constraints

- No new dependency — pdfkit's built-in named colors only (`'green'`, `'red'`, `'gray'`, `'black'`), no hex palette, no gradients.
- Adopt the reference report's *information architecture* (stat-card grid, explicit sections), never its branding (no dark hero banner, no logo, no rounded/shadowed cards).
- No charts/graphs, and no new ingestion telemetry beyond docs submitted/complete/failed + ingestion time — this pipeline has no GPU/pod/quota/concurrency data to show.
- No change to `answerContentMatch`'s aggregate computation, `computeAccuracy`'s weighting, or any threshold/pass-fail logic. The new per-question `score` is a display-only addition — it does not feed any aggregate or gating logic.
- No change to `results.json`'s stored `actualAnswer` — `perQuestionBreakdown` keeps the raw answer text with citation tags intact (`citationMatch` grading reads citations off the raw text). `formatAnswerWithCitations` runs only at PDF-render time inside `generate-pdf-report.js`, producing a display copy, never a stored one.
- Color correctness (does a cell actually render red/green/gray) is not something this codebase's test infrastructure can assert — `pdf-parse` extracts text only, never fill color, and no test in this file has ever inspected color. Tests verify the *value* rendered (and, where feasible, the pure color-mapping *function's* return value directly); actual on-page color is confirmed visually in Task 6's manual verification step, not by an automated assertion.
- Every task ends with `npm test` passing in full before its commit.

---

### Task 1: `drawStatCardRow` + `formatSeconds` helpers

**Files:**
- Modify: `scripts/generate-pdf-report.js`
- Modify: `scripts/generate-pdf-report.test.js`

**Interfaces:**
- Produces: `formatSeconds(ms) -> string` (e.g. `formatSeconds(12345) === '12.3s'`), `drawStatCardRow(doc, cards)` where `cards` is `Array<{ value: string|number, label: string, color?: string }>` — draws `cards.length` equal-width bordered boxes in a row and advances `doc.y`/`doc.x` past them. Both exported from `scripts/generate-pdf-report.js`. Later tasks (Task 5) call both.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/generate-pdf-report.test.js`. First, add `PDFDocument` to the requires at the top of the file (it's already a dependency, just not yet imported in this test file):

```js
const { PDFParse } = require('pdf-parse');
const PDFDocument = require('pdfkit');
const {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  formatSeconds,
  humanizeFieldName,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
  drawStatCardRow,
} = require('./generate-pdf-report');
```

Then add these tests (a good spot is right after the existing `formatLocalTimestamp zero-pads...` test, before `humanizeFieldName`):

```js
test('formatSeconds converts milliseconds to a one-decimal seconds string', () => {
  assert.equal(formatSeconds(12345), '12.3s');
  assert.equal(formatSeconds(30000), '30.0s');
  assert.equal(formatSeconds(999), '1.0s');
});

test('drawStatCardRow renders each card\'s value and label as text on the page', async () => {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve) => doc.on('end', resolve));

  drawStatCardRow(doc, [
    { value: 12, label: 'Docs submitted' },
    { value: 10, label: 'Docs complete', color: 'green' },
    { value: 2, label: 'Docs failed', color: 'red' },
    { value: '12.3s', label: 'Ingestion time' },
  ]);
  doc.end();
  await ended;

  const parser = new PDFParse({ data: Buffer.concat(chunks) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /12/);
  assert.match(text, /Docs submitted/);
  assert.match(text, /10/);
  assert.match(text, /Docs complete/);
  assert.match(text, /2/);
  assert.match(text, /Docs failed/);
  assert.match(text, /12\.3s/);
  assert.match(text, /Ingestion time/);
});

test('drawStatCardRow advances doc.y past the card row and resets doc.x to the left margin', () => {
  const doc = new PDFDocument({ margin: 50 });
  doc.on('data', () => {}); // drain so the stream doesn't back up
  const startY = doc.y;

  drawStatCardRow(doc, [
    { value: 1, label: 'A' },
    { value: 2, label: 'B' },
  ]);

  assert.equal(doc.y, startY + 60 + 12); // cardHeight (60) + the row's trailing gap (12)
  assert.equal(doc.x, doc.page.margins.left);
  doc.end();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx node --test scripts/generate-pdf-report.test.js`
Expected: FAIL — `formatSeconds` and `drawStatCardRow` are not exported (`TypeError: formatSeconds is not a function` or similar).

- [ ] **Step 3: Implement `formatSeconds` and `drawStatCardRow`**

In `scripts/generate-pdf-report.js`, add `formatSeconds` right after `formatLocalTimestamp` (before `humanizeFieldName`):

```js
// Formats a millisecond duration as a decimal-seconds string, e.g. 12345 -> "12.3s".
// Used by the ingestion/processing stat cards — raw ms/1000 division can produce
// long, ugly floats (12.345666...) that a stat card has no room to wrap.
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
```

Add `drawStatCardRow` right after `drawTableRow`'s closing brace (before `findComponent`):

```js
// Draws `cards.length` equal-width bordered boxes in a row: a large bold value on
// top, a small label beneath. `color` (optional, per card) tints just the value
// text — e.g. green for a clean success count, red for a nonzero failure count —
// everything else (borders, labels) stays plain black/gray, matching pdfkit's
// existing minimal aesthetic elsewhere in this file (drawTableRow's borders, the
// '#cccccc' question dividers).
function drawStatCardRow(doc, cards) {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 60;
  if (doc.y + cardHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const startY = doc.y;
  cards.forEach((card, i) => {
    const x = doc.page.margins.left + i * (cardWidth + gap);
    doc.rect(x, startY, cardWidth, cardHeight).stroke('#cccccc');
    doc.fontSize(18).font('Helvetica-Bold').fillColor(card.color || 'black')
      .text(String(card.value), x + 8, startY + 10, { width: cardWidth - 16 });
    doc.fontSize(9).font('Helvetica').fillColor('black')
      .text(card.label, x + 8, startY + 36, { width: cardWidth - 16 });
  });
  doc.y = startY + cardHeight + 12;
  doc.x = doc.page.margins.left;
}
```

Update `module.exports` at the bottom of the file to add both:

```js
module.exports = {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  formatSeconds,
  humanizeFieldName,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
  drawStatCardRow,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx node --test scripts/generate-pdf-report.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass (this task only adds new exports; nothing existing changes behavior).

```bash
git add scripts/generate-pdf-report.js scripts/generate-pdf-report.test.js
git commit -m "feat: add drawStatCardRow and formatSeconds helpers to generate-pdf-report.js"
```

---

### Task 2: `formatAnswerWithCitations` in `src/lib/extract-cited-file-names.js`

**Files:**
- Modify: `src/lib/extract-cited-file-names.js`
- Modify: `src/lib/extract-cited-file-names.test.js`

**Interfaces:**
- Consumes: `extractCitedCitationsFromText(text) -> Array<{fileName, documentId, chunkId}>` (existing, unchanged).
- Produces: `formatAnswerWithCitations(text) -> { cleanedText: string, legend: Array<{number: number, fileName: string}> }`, plus now-exported `FILE_NAME_ATTR_REGEX`/`DOCUMENT_ID_ATTR_REGEX`/`CHUNK_ID_ATTR_REGEX`. Task 5 imports `formatAnswerWithCitations` into `scripts/generate-pdf-report.js`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/extract-cited-file-names.test.js`. First, update the top require to also pull in the new function:

```js
const { extractCitedCitationsFromText, formatAnswerWithCitations } = require('./extract-cited-file-names');
```

Then append these tests at the end of the file:

```js
test('formatAnswerWithCitations replaces each citation tag with a numbered [n] marker, in order of first appearance', () => {
  const text = [
    'First point <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>.',
    'Second point <InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>.',
  ].join(' ');

  const { cleanedText, legend } = formatAnswerWithCitations(text);

  assert.equal(
    cleanedText,
    'First point [1]. Second point [2].'
  );
  assert.deepEqual(legend, [
    { number: 1, fileName: 'a.pdf' },
    { number: 2, fileName: 'b.pdf' },
  ]);
});

test('formatAnswerWithCitations reuses the same marker number when the same (documentId, chunkId) is cited twice', () => {
  const text = [
    'See <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and again <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>.',
  ].join(' ');

  const { cleanedText, legend } = formatAnswerWithCitations(text);

  assert.equal(cleanedText, 'See [1] and again [1].');
  assert.deepEqual(legend, [{ number: 1, fileName: 'a.pdf' }]);
});

test('formatAnswerWithCitations removes a tag missing fileName, documentId, or chunkId with no marker left behind', () => {
  const text = 'See <InTextCitation documentId="doc-1" chunkId="chunk-1"></InTextCitation> for details.';

  const { cleanedText, legend } = formatAnswerWithCitations(text);

  assert.equal(cleanedText, 'See  for details.');
  assert.deepEqual(legend, []);
});

test('formatAnswerWithCitations returns the text unchanged and an empty legend when there are no citation tags', () => {
  const { cleanedText, legend } = formatAnswerWithCitations('No sources found to answer this query!');
  assert.equal(cleanedText, 'No sources found to answer this query!');
  assert.deepEqual(legend, []);
});

test('formatAnswerWithCitations returns the input unchanged (and an empty legend) for null, undefined, or empty-string input, without throwing', () => {
  assert.deepEqual(formatAnswerWithCitations(null), { cleanedText: null, legend: [] });
  assert.deepEqual(formatAnswerWithCitations(undefined), { cleanedText: undefined, legend: [] });
  assert.deepEqual(formatAnswerWithCitations(''), { cleanedText: '', legend: [] });
});

test('formatAnswerWithCitations is reusable across multiple calls without leaking regex state', () => {
  const first = formatAnswerWithCitations('<InTextCitation fileName="one.pdf" documentId="d1" chunkId="c1"></InTextCitation>');
  const second = formatAnswerWithCitations('no citations here');
  const third = formatAnswerWithCitations('<InTextCitation fileName="two.pdf" documentId="d2" chunkId="c2"></InTextCitation>');
  assert.equal(first.cleanedText, '[1]');
  assert.equal(second.cleanedText, 'no citations here');
  assert.equal(third.cleanedText, '[1]');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx node --test src/lib/extract-cited-file-names.test.js`
Expected: FAIL — `formatAnswerWithCitations` is undefined.

- [ ] **Step 3: Implement `formatAnswerWithCitations`**

Replace the full contents of `src/lib/extract-cited-file-names.js` with:

```js
'use strict';

const TAG_REGEX = /<InTextCitation\b([^>]*)>/g;
const FILE_NAME_ATTR_REGEX = /fileName="([^"]*)"/;
const DOCUMENT_ID_ATTR_REGEX = /documentId="([^"]*)"/;
const CHUNK_ID_ATTR_REGEX = /chunkId="([^"]*)"/;

// Full open+close tag pair, unlike TAG_REGEX (which only needs the opening tag's
// attributes to extract data) — here the *entire* tag, including its closing
// </InTextCitation>, must be matched and removed, or the literal closing-tag text
// would be left behind in the cleaned prose.
const FULL_TAG_REGEX = /<InTextCitation\b([^>]*)><\/InTextCitation>/g;

// Extracts fileName, documentId, and chunkId from every <InTextCitation ...>
// tag in a single answer's raw text, decodeURIComponent-ing fileName (the
// real report URL-encodes it, e.g. "JOSE%2BBRIONES...pdf" ->
// "JOSE+BRIONES...pdf"). Deduplicated by the (documentId, chunkId) pair, NOT
// by fileName alone — a single source document is commonly split into many
// distinct cited chunks, and documentId/chunkId together identify exactly
// which chunk was cited, which fileName alone cannot. Order of first
// appearance is preserved. A tag missing any of the three attributes is
// skipped entirely — a citation missing documentId or chunkId can't be
// looked up in the S3 chunk-grounding file, so it's useless downstream.
function extractCitedCitationsFromText(text) {
  if (!text) {
    return [];
  }
  const citations = [];
  const seen = new Set();
  TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    const attrs = match[1];
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(attrs);
    const documentIdMatch = DOCUMENT_ID_ATTR_REGEX.exec(attrs);
    const chunkIdMatch = CHUNK_ID_ATTR_REGEX.exec(attrs);
    if (!fileNameMatch || !documentIdMatch || !chunkIdMatch) {
      continue;
    }
    const fileName = decodeURIComponent(fileNameMatch[1]);
    const documentId = documentIdMatch[1];
    const chunkId = chunkIdMatch[1];
    const key = `${documentId}:${chunkId}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ fileName, documentId, chunkId });
    }
  }
  return citations;
}

// Replaces every citation tag in `text` with a small inline [n] marker — same
// source cited twice reuses the same number — and returns an ordered legend for
// the sources actually referenced, for a short "Sources:" line below the answer.
// A tag missing fileName/documentId/chunkId (the same "useless downstream" case
// extractCitedCitationsFromText already skips) is removed with no marker, rather
// than left as raw markup.
function formatAnswerWithCitations(text) {
  if (!text) {
    return { cleanedText: text, legend: [] };
  }
  const citations = extractCitedCitationsFromText(text);
  const numberByKey = new Map(citations.map((c, i) => [`${c.documentId}:${c.chunkId}`, i + 1]));

  FULL_TAG_REGEX.lastIndex = 0;
  const cleanedText = text.replace(FULL_TAG_REGEX, (whole, attrs) => {
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(attrs);
    const documentIdMatch = DOCUMENT_ID_ATTR_REGEX.exec(attrs);
    const chunkIdMatch = CHUNK_ID_ATTR_REGEX.exec(attrs);
    if (!fileNameMatch || !documentIdMatch || !chunkIdMatch) {
      return '';
    }
    const n = numberByKey.get(`${documentIdMatch[1]}:${chunkIdMatch[1]}`);
    return n ? `[${n}]` : '';
  });

  const legend = citations.map((c, i) => ({ number: i + 1, fileName: c.fileName }));
  return { cleanedText, legend };
}

module.exports = {
  extractCitedCitationsFromText,
  formatAnswerWithCitations,
  FILE_NAME_ATTR_REGEX,
  DOCUMENT_ID_ATTR_REGEX,
  CHUNK_ID_ATTR_REGEX,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx node --test src/lib/extract-cited-file-names.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/lib/extract-cited-file-names.js src/lib/extract-cited-file-names.test.js
git commit -m "feat: add formatAnswerWithCitations for numbered inline citation markers"
```

---

### Task 3: Per-question numeric `score` from the grader

**Files:**
- Modify: `src/lib/qa-match-assertion.js`
- Modify: `src/lib/qa-match-assertion.test.js`

**Interfaces:**
- Produces: `perQuestionBreakdown[i].score` — a `0-100` number from the grader, alongside the existing `matches`/`reason` fields. `parseGraderVerdict(responseOutput) -> { matches, reason, score }` where `score` is `undefined` when absent from the response (the citation-grading call path never sends a score request and must keep working). Task 5 reads `entry.score` in `scripts/generate-pdf-report.js`.
- **Decision: additive, not a replacement.** `answerContentMatch` keeps its exact current computation (`perQuestionBreakdown.filter((v) => v.matches).length / perQuestionBreakdown.length`) — `score` does not feed it, `computeAccuracy`, or any pass/fail threshold.

- [ ] **Step 1: Write the failing tests**

In `src/lib/qa-match-assertion.test.js`, replace the existing `buildQuestionGradingPrompt embeds...` test (lines 47-55) with:

```js
test('buildQuestionGradingPrompt embeds the question, expected answer, actual answer, and asks for a 0-100 score', () => {
  const question = { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' };
  const prompt = buildQuestionGradingPrompt(question, 'Yes, doc X confirms it.');

  assert.match(prompt, /Is there fraud\?/);
  assert.match(prompt, /Yes, per doc X\./);
  assert.match(prompt, /Yes, doc X confirms it\./);
  assert.match(prompt, /0-100 scale/);
  assert.match(prompt, /"matches": boolean, "score": number, "reason": string/);
});
```

Replace the existing `parseGraderVerdict parses a clean JSON response` and `parseGraderVerdict extracts JSON even when wrapped in markdown code fences` tests (lines 57-65) with:

```js
test('parseGraderVerdict parses a clean JSON response with a score', () => {
  const result = parseGraderVerdict('{"matches": true, "score": 87, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches', score: 87 });
});

test('parseGraderVerdict parses a response with no score field (the citation-grading shape) and returns score: undefined', () => {
  const result = parseGraderVerdict('{"matches": true, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches', score: undefined });
});

test('parseGraderVerdict extracts JSON even when wrapped in markdown code fences', () => {
  const response = '```json\n{"matches": false, "score": 12, "reason": "no match"}\n```';
  assert.deepEqual(parseGraderVerdict(response), { matches: false, reason: 'no match', score: 12 });
});
```

Replace the existing `parseGraderVerdict throws a clear error when matches or reason fields are missing or the wrong type` test (lines 71-74) with:

```js
test('parseGraderVerdict throws a clear error when matches or reason fields are missing or the wrong type', () => {
  assert.throws(() => parseGraderVerdict('{"matches": "yes", "reason": "ok"}'), /missing matches\/reason fields/);
  assert.throws(() => parseGraderVerdict('{"matches": true}'), /missing matches\/reason fields/);
});

test('parseGraderVerdict throws when score is present but out of range or the wrong type', () => {
  assert.throws(
    () => parseGraderVerdict('{"matches": true, "score": 150, "reason": "ok"}'),
    /score must be a number in \[0,100\]/
  );
  assert.throws(
    () => parseGraderVerdict('{"matches": true, "score": -1, "reason": "ok"}'),
    /score must be a number in \[0,100\]/
  );
  assert.throws(
    () => parseGraderVerdict('{"matches": true, "score": "87", "reason": "ok"}'),
    /score must be a number in \[0,100\]/
  );
});
```

Update the `qaMatchAssertion returns one perQuestionBreakdown entry per question` test (lines 130-148) — its mock response has no score, so add `score: undefined` to the expected object:

```js
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
    score: undefined,
    actualCitedFileNames: [],
    citationMatches: undefined,
    citationMatchReason: undefined,
  });
});
```

Add a new test right after it verifying `score` flows through when the grader provides one:

```js
test('qaMatchAssertion carries the grader\'s score through to perQuestionBreakdown, without affecting answerContentMatch', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async () => {
    callCount += 1;
    const scores = [90, 40, 70];
    return { output: JSON.stringify({ matches: true, score: scores[callCount - 1], reason: `reason ${callCount}` }) };
  });

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown[0].score, 90);
  assert.equal(result.perQuestionBreakdown[1].score, 40);
  assert.equal(result.perQuestionBreakdown[2].score, 70);
  // all three mocked "matches: true" -> answerContentMatch is unaffected by the score values above
  assert.equal(result.namedScores.answerContentMatch, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx node --test src/lib/qa-match-assertion.test.js`
Expected: FAIL — the updated `buildQuestionGradingPrompt`/`parseGraderVerdict` assertions don't match current behavior, and `perQuestionBreakdown[0].score` is `undefined` where the new test expects specific numbers (actually: it will fail because `score` key doesn't exist on the returned object at all yet, and `assert.deepEqual` requires an exact key match).

- [ ] **Step 3: Implement the grader score**

In `src/lib/qa-match-assertion.js`, replace `buildQuestionGradingPrompt`:

```js
function buildQuestionGradingPrompt(question, actualAnswer) {
  return [
    `Question: ${question.question}`,
    `Expected answer: ${question.expectedAnswerSummary}`,
    `Model answer: ${actualAnswer}`,
    '',
    "Does the model answer's content and reasoning semantically match the expected answer above",
    '(exact wording does not matter, meaning does)? Also rate how well the model answer captures',
    'the expected answer on a 0-100 scale (100 = perfect semantic match, 0 = completely wrong or',
    'missing). Respond with only a JSON object, no other text:',
    '{"matches": boolean, "score": number, "reason": string}.',
  ].join('\n');
}
```

Replace `parseGraderVerdict`:

```js
function parseGraderVerdict(responseOutput) {
  const text = typeof responseOutput === 'string' ? responseOutput : JSON.stringify(responseOutput);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not find a JSON object in grader response: ${text}`);
  }
  const parsed = JSON.parse(match[0]);
  if (typeof parsed.matches !== 'boolean' || typeof parsed.reason !== 'string') {
    throw new Error(`Grader response JSON missing matches/reason fields: ${text}`);
  }
  if (parsed.score !== undefined && (typeof parsed.score !== 'number' || Number.isNaN(parsed.score) || parsed.score < 0 || parsed.score > 100)) {
    throw new Error(`Grader response score must be a number in [0,100] when present: ${text}`);
  }
  return { matches: parsed.matches, reason: parsed.reason, score: parsed.score };
}
```

In `qaMatchAssertion`'s per-question loop, change:

```js
    const { matches, reason } = parseGraderVerdict(response.output);
```

to:

```js
    const { matches, reason, score } = parseGraderVerdict(response.output);
```

and add `score` to the `perQuestionBreakdown.push({...})` call, right after `reason,`:

```js
    perQuestionBreakdown.push({
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      actualAnswer,
      riskStatus,
      riskStatusMatches,
      matches,
      reason,
      score,
      actualCitedFileNames,
      citationMatches,
      citationMatchReason,
    });
```

Note: `parseGraderVerdict` is also used inside `matchesAnyResolvedChunk` (the citation-grading path) — that call site destructures only `{ matches, reason }` and simply ignores the new `score` key, so it needs no changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx node --test src/lib/qa-match-assertion.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/lib/qa-match-assertion.js src/lib/qa-match-assertion.test.js
git commit -m "feat: add a per-question 0-100 grader score to perQuestionBreakdown"
```

---

### Task 4: `docsSubmitted`/`docsComplete` counts on `output.ingestion`

**Files:**
- Modify: `src/provider.js`
- Modify: `src/provider.test.js`

**Interfaces:**
- Produces: `output.ingestion.docsSubmitted` (= `sourceDocs.length`), `output.ingestion.docsComplete` (= `sourceDocs.length - failedDocuments.length`). `output.failedDocuments` already exists (added by the bucket-driven-baseline plan) and is read directly by Task 5 for the "Docs failed" count — not duplicated onto `ingestion`.

- [ ] **Step 1: Write the failing tests**

Add to `src/provider.test.js`, right after the existing `callApi sets output.failedDocuments to an empty array when every document copies successfully` test:

```js
test('callApi reports docsSubmitted and docsComplete counts on output.ingestion', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, happyPathMocks([]));

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(result.output.ingestion.docsSubmitted, 1);
  assert.equal(result.output.ingestion.docsComplete, 1);
});

test('callApi reports docsComplete lower than docsSubmitted when some documents fail', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    listBucketDocuments: async () => [
      { gxMasterId: 1, fileName: 'a.pdf', extension: 'pdf' },
      { gxMasterId: 2, fileName: 'b.pdf', extension: 'pdf' },
    ],
    requestUploadUrls: async (base, auth, files) => {
      if (files[0].fileName === 'b.pdf') {
        throw new Error('upload URL service unavailable');
      }
      return [{ fileName: files[0].fileName, jobId: 1, uploadUrl: 'https://s3.example/put' }];
    },
  });

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(result.output.ingestion.docsSubmitted, 2);
  assert.equal(result.output.ingestion.docsComplete, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx node --test src/provider.test.js`
Expected: FAIL — `result.output.ingestion.docsSubmitted` is `undefined`.

- [ ] **Step 3: Implement the counts**

In `src/provider.js`, find the `return { output: { ... } }` block at the end of `callApi` and change:

```js
    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
```

to:

```js
    return {
      output: {
        ingestion: {
          timeMs: ingestionTimeMs,
          docsSubmitted: sourceDocs.length,
          docsComplete: sourceDocs.length - failedDocuments.length,
        },
        processing: { timeMs: processingTimeMs },
```

(the rest of the object — `report`, `citedDocumentsText`, `chunkGroundingData`, `failedDocuments` — is unchanged).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx node --test src/provider.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/provider.js src/provider.test.js
git commit -m "feat: report docsSubmitted/docsComplete counts on output.ingestion"
```

---

### Task 5: Rewrite `renderClaimPdf` into the two-section layout

**Files:**
- Modify: `scripts/generate-pdf-report.js`
- Modify: `scripts/generate-pdf-report.test.js`

**Interfaces:**
- Consumes: `drawStatCardRow`/`formatSeconds` (Task 1, same file), `formatAnswerWithCitations` (Task 2, `src/lib/extract-cited-file-names.js`), `perQuestionBreakdown[i].score` (Task 3), `output.ingestion.docsSubmitted`/`docsComplete` (Task 4), `output.failedDocuments` (pre-existing).
- Produces: the final two-section PDF layout. Nothing later depends on new exports from this task beyond what's already used internally, except three small color/format helpers this task adds and unit-tests directly: `formatRiskStatus`, `riskStatusColor`, `booleanMatchColor`, `citationMatchColor`.

This task replaces the entire contents of both files. Both are given in full below — read them fully before starting; do not attempt to hand-derive a diff against the files' current state.

- [ ] **Step 1: Write the complete new test file (it will fail against the old implementation)**

Replace the full contents of `scripts/generate-pdf-report.test.js` with:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const PDFDocument = require('pdfkit');
const {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  formatSeconds,
  humanizeFieldName,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
  formatRiskStatus,
  riskStatusColor,
  booleanMatchColor,
  citationMatchColor,
  drawStatCardRow,
} = require('./generate-pdf-report');

// Fixed to UTC so tests that feed a UTC instant (e.g. via FIXED_NOW below) get
// deterministic, environment-independent "local time" output. Each test file
// runs in its own process under node:test, so this doesn't leak to other files.
process.env.TZ = 'UTC';

function sampleResultsFile() {
  return {
    results: {
      timestamp: '2026-08-13T05:52:47.729Z',
      results: [
        {
          vars: {
            expected: {
              fraudRiskScore: 0.68,
              claimantName: 'Jose Briones',
              defendant: 'One Team Restoration, Inc.',
              insuranceFirm: 'New York State Insurance Fund (NYSIF)',
            },
          },
          response: {
            output: {
              ingestion: { timeMs: 30000, docsSubmitted: 1, docsComplete: 1 },
              processing: { timeMs: 60000 },
              failedDocuments: [],
              report: {
                bucketId: 32023,
                fraudRiskScore: 0.7,
                claimantName: 'Jose Briones',
                defendant: 'One Team Restoration, Inc.',
                insuranceFirm: 'New York State Insurance Fund (NYSIF)',
              },
            },
          },
          gradingResult: {
            namedScores: {
              riskStatusMatch: 0.8,
              answerContentMatch: 0.6,
              report_quality: 0.75,
              fraudRiskScoreMatch: 1,
              entityFieldsMatch: 1,
            },
            componentResults: [
              {
                assertion: { metric: 'qa_match' },
                perQuestionBreakdown: [
                  { predefinedQuestionId: 1, question: 'Is there fraud?', actualAnswer: 'RISK DETECTED: Yes, per doc X.', riskStatus: 'RISK_DETECTED', riskStatusMatches: true, matches: true, score: 87, reason: 'Matches expected reasoning' },
                ],
              },
              {
                assertion: { metric: 'report_quality' },
                reason: 'Summary is complete and grounded.',
              },
            ],
          },
        },
      ],
    },
  };
}

// Used to give generatePdfReports a deterministic "now" in tests instead of
// the real wall-clock time a live run would use.
const FIXED_NOW = () => new Date('2026-08-13T05:52:47.729Z');

test('formatTimestampForFilename converts an ISO timestamp into a filesystem-safe string', () => {
  assert.equal(formatTimestampForFilename('2026-08-13T05:52:47.729Z'), '2026-08-13T05-52-47');
});

test('formatLocalTimestamp always renders IST (Asia/Kolkata), regardless of the process\'s own timezone', (t) => {
  const originalTz = process.env.TZ;
  t.after(() => {
    process.env.TZ = originalTz;
  });

  const instant = new Date('2026-08-13T05:52:47.000Z');

  // CI runners default to UTC with no TZ set; a dev machine might be in any
  // zone. Either way the report must read IST, not whatever the host is in.
  process.env.TZ = 'UTC';
  assert.equal(formatLocalTimestamp(instant), '2026-08-13T11:22:47');

  process.env.TZ = 'America/New_York';
  assert.equal(formatLocalTimestamp(instant), '2026-08-13T11:22:47');
});

test('formatLocalTimestamp zero-pads month, day, hour, minute, and second', () => {
  process.env.TZ = 'UTC';
  assert.equal(formatLocalTimestamp(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T08:34:05');
});

test('formatSeconds converts milliseconds to a one-decimal seconds string', () => {
  assert.equal(formatSeconds(12345), '12.3s');
  assert.equal(formatSeconds(30000), '30.0s');
  assert.equal(formatSeconds(999), '1.0s');
});

test('drawStatCardRow renders each card\'s value and label as text on the page', async () => {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve) => doc.on('end', resolve));

  drawStatCardRow(doc, [
    { value: 12, label: 'Docs submitted' },
    { value: 10, label: 'Docs complete', color: 'green' },
    { value: 2, label: 'Docs failed', color: 'red' },
    { value: '12.3s', label: 'Ingestion time' },
  ]);
  doc.end();
  await ended;

  const parser = new PDFParse({ data: Buffer.concat(chunks) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /12/);
  assert.match(text, /Docs submitted/);
  assert.match(text, /10/);
  assert.match(text, /Docs complete/);
  assert.match(text, /2/);
  assert.match(text, /Docs failed/);
  assert.match(text, /12\.3s/);
  assert.match(text, /Ingestion time/);
});

test('drawStatCardRow advances doc.y past the card row and resets doc.x to the left margin', () => {
  const doc = new PDFDocument({ margin: 50 });
  doc.on('data', () => {}); // drain so the stream doesn't back up
  const startY = doc.y;

  drawStatCardRow(doc, [
    { value: 1, label: 'A' },
    { value: 2, label: 'B' },
  ]);

  assert.equal(doc.y, startY + 60 + 12); // cardHeight (60) + the row's trailing gap (12)
  assert.equal(doc.x, doc.page.margins.left);
  doc.end();
});

test('humanizeFieldName splits camelCase into title-cased words', () => {
  assert.equal(humanizeFieldName('fraudRiskScore'), 'Fraud Risk Score');
  assert.equal(humanizeFieldName('claimantName'), 'Claimant Name');
  assert.equal(humanizeFieldName('insuranceFirm'), 'Insurance Firm');
});

test('humanizeFieldName leaves a single lowercase word capitalized but otherwise unchanged', () => {
  assert.equal(humanizeFieldName('defendant'), 'Defendant');
});

test('sortByRiskStatus orders Detected before Unsure before Not Detected, regardless of input order', () => {
  const input = [
    { id: 'a', riskStatus: 'UNSURE' },
    { id: 'b', riskStatus: 'RISK_NOT_DETECTED' },
    { id: 'c', riskStatus: 'RISK_DETECTED' },
  ];
  assert.deepEqual(sortByRiskStatus(input).map((e) => e.id), ['c', 'a', 'b']);
});

test('sortByRiskStatus is stable within the same risk status and sorts a missing/unknown status last', () => {
  const input = [
    { id: 'a', riskStatus: 'UNSURE' },
    { id: 'b', riskStatus: undefined },
    { id: 'c', riskStatus: 'RISK_DETECTED' },
    { id: 'd', riskStatus: 'UNSURE' },
  ];
  assert.deepEqual(sortByRiskStatus(input).map((e) => e.id), ['c', 'a', 'd', 'b']);
});

test('sortByRiskStatus does not mutate the input array', () => {
  const input = [{ id: 'a', riskStatus: 'UNSURE' }, { id: 'b', riskStatus: 'RISK_DETECTED' }];
  const copy = [...input];
  sortByRiskStatus(input);
  assert.deepEqual(input, copy);
});

test('formatCitationMatch renders YES for a matching citation', () => {
  assert.equal(formatCitationMatch({ citationMatches: true }), 'YES');
});

test('formatCitationMatch renders NO with the grader\'s reason for a non-matching citation', () => {
  assert.equal(
    formatCitationMatch({ citationMatches: false, citationMatchReason: 'The cited passage does not mention the expected entity.' }),
    'NO (The cited passage does not mention the expected entity.)'
  );
});

test('formatCitationMatch renders N/A when citationMatches is undefined', () => {
  assert.equal(formatCitationMatch({ citationMatches: undefined }), 'N/A');
  assert.equal(formatCitationMatch({ citationMatches: null }), 'N/A');
});

test('formatRiskStatus spaces out the enum\'s underscores for display', () => {
  assert.equal(formatRiskStatus('RISK_DETECTED'), 'RISK DETECTED');
  assert.equal(formatRiskStatus('RISK_NOT_DETECTED'), 'RISK NOT DETECTED');
  assert.equal(formatRiskStatus('UNSURE'), 'UNSURE');
});

test('formatRiskStatus renders N/A for a missing riskStatus', () => {
  assert.equal(formatRiskStatus(undefined), 'N/A');
  assert.equal(formatRiskStatus(null), 'N/A');
});

test('riskStatusColor maps RISK_DETECTED to red, RISK_NOT_DETECTED to green, UNSURE to gray, and anything else to black', () => {
  assert.equal(riskStatusColor('RISK_DETECTED'), 'red');
  assert.equal(riskStatusColor('RISK_NOT_DETECTED'), 'green');
  assert.equal(riskStatusColor('UNSURE'), 'gray');
  assert.equal(riskStatusColor(undefined), 'black');
  assert.equal(riskStatusColor('SOMETHING_ELSE'), 'black');
});

test('booleanMatchColor maps true to green and false to red', () => {
  assert.equal(booleanMatchColor(true), 'green');
  assert.equal(booleanMatchColor(false), 'red');
});

test('citationMatchColor maps true to green, false to red, and null/undefined (N/A) to gray', () => {
  assert.equal(citationMatchColor({ citationMatches: true }), 'green');
  assert.equal(citationMatchColor({ citationMatches: false }), 'red');
  assert.equal(citationMatchColor({ citationMatches: undefined }), 'gray');
  assert.equal(citationMatchColor({ citationMatches: null }), 'gray');
});

test('uniqueFilePath returns the given path unchanged when nothing exists there yet', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-file-path-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const target = path.join(tmpDir, 'report.pdf');
  assert.equal(uniqueFilePath(target), target);
});

test('uniqueFilePath appends -2, -3, ... to avoid an existing file, preserving the extension', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-file-path-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const target = path.join(tmpDir, 'report.pdf');
  fs.writeFileSync(target, 'first');
  assert.equal(uniqueFilePath(target), path.join(tmpDir, 'report-2.pdf'));

  fs.writeFileSync(path.join(tmpDir, 'report-2.pdf'), 'second');
  assert.equal(uniqueFilePath(target), path.join(tmpDir, 'report-3.pdf'));
});

test('generatePdfReports writes one PDF per claim with a bucketId, at reports/<bucketId>/report-<timestamp>.pdf', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.equal(written[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.ok(fs.existsSync(written[0]));
});

test('generatePdfReports stamps each run with its own actual generation time, not the frozen results.timestamp', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const firstRun = await generatePdfReports(resultsPath, reportsDir, () => new Date('2026-08-13T05:52:47.729Z'));
  const secondRun = await generatePdfReports(resultsPath, reportsDir, () => new Date('2026-08-14T09:15:03.000Z'));

  assert.equal(firstRun[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.equal(secondRun[0], path.join(reportsDir, '32023', 'report-2026-08-14T14-45-03.pdf'));
  assert.notEqual(secondRun[0], firstRun[0]);
  assert.ok(fs.existsSync(firstRun[0]), 'the original report must still exist');
  assert.ok(fs.existsSync(secondRun[0]), 'a new, distinctly timestamped report must have been written');
});

test('generatePdfReports falls back to a numeric suffix, not an overwrite, on the rare case of two runs in the same second', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const firstRun = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);
  const originalPath = firstRun[0];
  const originalContent = fs.readFileSync(originalPath);

  const secondRun = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(secondRun[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47-2.pdf'));
  assert.notEqual(secondRun[0], originalPath);
  assert.ok(fs.existsSync(originalPath), 'the original report must still exist');
  assert.ok(fs.existsSync(secondRun[0]), 'a new report must have been written');
  assert.deepEqual(fs.readFileSync(originalPath), originalContent, 'the original report must be untouched');
});

test('generatePdfReports skips a claim with no bucketId (errored before a report existed)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = {
    results: {
      timestamp: '2026-08-13T05:52:47.729Z',
      results: [{ error: 'Creating a claim failed: 404 INGESTION model is not found.' }],
    },
  };
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 0);
  assert.ok(!fs.existsSync(reportsDir));
});

test('generatePdfReports skips a claim with a bucketId but missing gradingResult.namedScores, and still writes the PDF for a healthy claim later in the same file', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 99999;
  delete malformedClaim.gradingResult.namedScores;
  // Put the malformed claim first so a naive implementation that throws
  // on it would abort before ever reaching the healthy claim below.
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.equal(written[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.ok(fs.existsSync(written[0]));
  assert.ok(!fs.existsSync(path.join(reportsDir, '99999')));
});

test('generatePdfReports skips a claim missing docsSubmitted/docsComplete on output.ingestion', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 77777;
  delete malformedClaim.response.output.ingestion.docsSubmitted;
  delete malformedClaim.response.output.ingestion.docsComplete;
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.equal(written[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.ok(!fs.existsSync(path.join(reportsDir, '77777')));
});

test('generatePdfReports renders the Document Ingestion section with docs submitted/complete/failed counts and ingestion time', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  fixture.results.results[0].response.output.ingestion = { timeMs: 12300, docsSubmitted: 5, docsComplete: 3 };
  fixture.results.results[0].response.output.failedDocuments = [
    { fileName: 'a.pdf', error: 'upload URL service unavailable' },
    { fileName: 'b.pdf', error: 'timed out waiting for GX processing' },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Document Ingestion/);
  assert.match(text, /Docs submitted/);
  assert.match(text, /5/);
  assert.match(text, /Docs complete/);
  assert.match(text, /3/);
  assert.match(text, /Docs failed/);
  assert.match(text, /12\.3s/);
  assert.match(text, /Ingestion time/);
  assert.match(text, /Failed documents:/);
  assert.match(text, /a\.pdf: upload URL service unavailable/);
  assert.match(text, /b\.pdf: timed out waiting for GX processing/);
});

test('generatePdfReports renders no "Failed documents" heading at all when failedDocuments is empty', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile())); // failedDocuments: []
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.doesNotMatch(text, /Failed documents:/);
});

test('generatePdfReports renders the Claim Processing section heading with accuracy, processing time, risk status match, and answer content match cards', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // namedScores: riskStatusMatch 0.8 -> 80%, answerContentMatch 0.6 -> 60%,
  // accuracy = round(25*0.6 + 25*0.75 + 25*1 + 25*1) = round(83.75) = 84.
  assert.match(text, /Claim Processing/);
  assert.match(text, /Accuracy/);
  assert.match(text, /84/);
  assert.match(text, /Processing time/);
  assert.match(text, /60\.0s/);
  assert.match(text, /Risk status match/);
  assert.match(text, /80%/);
  assert.match(text, /Answer content match/);
  assert.match(text, /60%/);
  // No assertion that "Citation Match" is absent here: the Q&A table's column
  // header (Task 5's 4-column row) always reads "Citation Match" regardless of
  // whether the 5th stat card renders — that's a different element with the
  // same text. The conditional 5th-card behavior is covered on its own below.
});

test('generatePdfReports renders a 5th Citation match stat card only when namedScores.citationMatch is defined', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  fixture.results.results[0].gradingResult.namedScores.citationMatch = 0.5;
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Citation match/);
  assert.match(text, /50%/);
});

test('generatePdfReports writes a PDF whose text includes the bucketId, question text, entity names, and report_quality reasoning', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Claim Eval Report/);
  assert.doesNotMatch(text, /Claim Eval Report.*32023/);
  assert.match(text, /Bucket ID: 32023/);
  assert.match(text, /Generated at: 2026-08-13T11:22:47\n/);
  assert.match(text, /Is there fraud\?/);
  assert.match(text, /Risk Status/); // Q&A table header
  assert.match(text, /Score/);
  assert.match(text, /Risk Match/);
  assert.match(text, /Citation Match/);
  assert.match(text, /RISK DETECTED/); // this question's actual (formatted) riskStatus
  assert.match(text, /87%/); // this question's per-question score
  assert.match(text, /Answer: RISK DETECTED: Yes, per doc X\./, 'the risk-status prefix must remain in the rendered answer text');
  assert.match(text, /Summary is complete and grounded\./);
  assert.match(text, /Jose Briones/);
  assert.match(text, /One Team Restoration, Inc\./);
  assert.match(text, /Fraud Risk Score/);
  assert.match(text, /Claimant Name/);
  assert.match(text, /Insurance Firm/);
  assert.doesNotMatch(text, /fraudRiskScore/);
  assert.doesNotMatch(text, /claimantName/);
  assert.doesNotMatch(text, /insuranceFirm/);
});

test('generatePdfReports numbers questions sequentially in Detected/Unsure/Not-Detected order, not by predefinedQuestionId', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  // Deliberately out of both ID order and risk-status order.
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 900, question: 'UNSURE-QUESTION', actualAnswer: 'a', riskStatus: 'UNSURE', matches: true, score: 60, reason: 'r' },
    { predefinedQuestionId: 100, question: 'NOT-DETECTED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_NOT_DETECTED', matches: true, score: 70, reason: 'r' },
    { predefinedQuestionId: 500, question: 'DETECTED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_DETECTED', matches: true, score: 80, reason: 'r' },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Q1: DETECTED-QUESTION/);
  assert.match(text, /Q2: UNSURE-QUESTION/);
  assert.match(text, /Q3: NOT-DETECTED-QUESTION/);
  assert.doesNotMatch(text, /Q900/);
  assert.doesNotMatch(text, /Q100/);
  assert.doesNotMatch(text, /Q500/);
});

test('generatePdfReports keeps a question\'s content together in reading order, without truncation, even when its reason text forces a page break', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  // A realistically long reason (2,500+ chars) — long enough that, at this repo's
  // table-column widths, it would have forced pdfkit to auto-paginate mid-column
  // under the old 4-column drawTableRow layout, tearing this row's Answer/Match/
  // Reason across pages. Under the new per-question block layout it should just
  // flow across the page break within this one question's paragraph.
  const longReasonBegin = 'REASON-BEGIN-MARKER';
  const longReasonEnd = 'REASON-END-MARKER';
  // Repeated 100x (~8,100 chars) — comfortably past this repo's real observed max
  // answer/reason length (7,299 chars) — so this reliably forces a page break
  // regardless of margins/font metrics, unlike a value merely close to one page.
  const longReason = `${longReasonBegin} ${'The grader compared the actual answer against the expected summary in detail. '.repeat(100)} ${longReasonEnd}`;
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 1, question: 'FIRST-QUESTION-MARKER: Is there fraud?', actualAnswer: 'Yes, per doc X.', matches: true, score: 90, reason: 'Short first reason.' },
    { predefinedQuestionId: 2, question: 'SECOND-QUESTION-MARKER: What is the claim status?', actualAnswer: 'Open, pending review.', matches: false, score: 20, reason: longReason },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  let pages;
  try {
    const result = await parser.getText();
    text = result.text;
    pages = result.pages;
  } finally {
    await parser.destroy();
  }

  const pageOf = (marker) => pages.find((p) => p.text.includes(marker))?.num;
  const beginPage = pageOf(longReasonBegin);
  const endPage = pageOf(longReasonEnd);

  // Sanity check that this fixture actually exercises a page break — otherwise the
  // ordering/truncation assertions below wouldn't be testing anything meaningful.
  assert.ok(pages.length > 1, `expected the long reason to force a multi-page PDF, got ${pages.length} page(s)`);
  assert.ok(
    beginPage !== undefined && endPage !== undefined && beginPage < endPage,
    `expected the long reason to actually straddle a page break (begin on page ${beginPage}, end on page ${endPage})`
  );

  assert.match(text, /FIRST-QUESTION-MARKER/);
  assert.match(text, /SECOND-QUESTION-MARKER/);
  assert.ok(
    text.indexOf('FIRST-QUESTION-MARKER') < text.indexOf('SECOND-QUESTION-MARKER'),
    'expected the first question to appear before the second question in reading order'
  );
  assert.match(text, new RegExp(longReasonBegin));
  assert.match(text, new RegExp(longReasonEnd));
  assert.ok(
    text.indexOf(longReasonBegin) < text.indexOf(longReasonEnd),
    'expected the beginning of the long reason to appear before its end'
  );
});

test('generatePdfReports renders the fallback text (not the literal string "undefined") when the report_quality component has no reason field', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const reportQualityComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'report_quality'
  );
  delete reportQualityComponent.reason;
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /\(no report_quality reasoning available\)/);
  assert.doesNotMatch(text, /undefined/);
});

test('generatePdfReports logs a console.error mentioning the bucketId of a claim it skips', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 88888;
  delete malformedClaim.gradingResult.namedScores;
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.ok(
    errorCalls.some((message) => message.includes('88888')),
    `expected a console.error call mentioning bucketId 88888, got: ${JSON.stringify(errorCalls)}`
  );
});

test('generatePdfReports renders Citation Match as YES, NO (with the grader\'s reason), and N/A per question', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 1, question: 'MATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_DETECTED', riskStatusMatches: true, matches: true, score: 95, reason: 'r', actualCitedFileNames: ['a.pdf'], citationMatches: true, citationMatchReason: 'Matches the expected passage.' },
    { predefinedQuestionId: 2, question: 'MISMATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'UNSURE', riskStatusMatches: false, matches: true, score: 40, reason: 'r', actualCitedFileNames: ['c.pdf'], citationMatches: false, citationMatchReason: 'The cited passage is unrelated to the expected passage.' },
    { predefinedQuestionId: 3, question: 'UNGRADED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_NOT_DETECTED', riskStatusMatches: true, matches: true, score: 75, reason: 'r', actualCitedFileNames: ['z.pdf'], citationMatches: undefined, citationMatchReason: undefined },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // Risk-status ordering puts MATCHED (RISK_DETECTED) first, MISMATCHED (UNSURE) second,
  // UNGRADED (RISK_NOT_DETECTED) third — so these markers already appear in this order.
  // Each fixture entry has a distinct (formatted) riskStatus, so it doubles as an
  // unambiguous per-question anchor for the values that follow it.
  assert.match(text, /MATCHED-QUESTION[\s\S]*?RISK DETECTED[\s\S]*?95%[\s\S]*?YES/);
  assert.match(text, /MISMATCHED-QUESTION[\s\S]*?UNSURE[\s\S]*?40%[\s\S]*?NO \(The cited passage is unrelated to the expected passage\.\)/);
  assert.match(text, /UNGRADED-QUESTION[\s\S]*?RISK NOT DETECTED[\s\S]*?75%[\s\S]*?N\/A/);
});

test('generatePdfReports shows a numbered [n] marker in the Answer paragraph instead of a raw <InTextCitation> tag, with a Sources line below it', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  qaMatchComponent.perQuestionBreakdown = [
    {
      predefinedQuestionId: 1,
      question: 'CITED-QUESTION',
      actualAnswer: 'Fraud detected <InTextCitation fileName="report-a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation> per the filing.',
      riskStatus: 'RISK_DETECTED',
      riskStatusMatches: true,
      matches: true,
      score: 88,
      reason: 'r',
    },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Fraud detected \[1\] per the filing\./);
  assert.doesNotMatch(text, /InTextCitation/);
  assert.match(text, /Sources: \[1\] report-a\.pdf/);
});

test('generatePdfReports shows no Sources line when the answer has no citations', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile())); // actualAnswer has no citation tags
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.doesNotMatch(text, /Sources:/);
});

test('running generate-pdf-report.js as a CLI exits non-zero when a claim in results.json errored, even though it still writes the PDF for a healthy claim in the same file', (t) => {
  const { execFileSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-cli-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 99999;
  delete malformedClaim.gradingResult.namedScores;
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'generate-pdf-report.js'), resultsPath, reportsDir], { stdio: 'pipe' });
  } catch (err) {
    status = err.status;
  }

  assert.equal(status, 1);
  assert.ok(fs.existsSync(path.join(reportsDir, '32023')), 'the healthy claim\'s PDF should still be written');
  assert.ok(!fs.existsSync(path.join(reportsDir, '99999')));
});

test('running generate-pdf-report.js as a CLI exits zero when every claim in results.json is healthy', (t) => {
  const { execFileSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-cli-clean-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  // Throws if the child process exits non-zero.
  execFileSync(process.execPath, [path.join(__dirname, 'generate-pdf-report.js'), resultsPath, reportsDir], { stdio: 'pipe' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx node --test scripts/generate-pdf-report.test.js`
Expected: FAIL — many tests fail (`formatRiskStatus`/`riskStatusColor`/`booleanMatchColor`/`citationMatchColor` undefined; layout assertions like `Document Ingestion`/`Claim Processing` don't match the old single-flow output).

- [ ] **Step 3: Replace the full contents of `scripts/generate-pdf-report.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { entitiesMatch, fraudRiskScoreMatches } = require('../src/lib/metadata-match-assertion');
const { formatAnswerWithCitations } = require('../src/lib/extract-cited-file-names');
const { computeAccuracy, scoreDashboard, dashboardHasErrors } = require('./score-dashboard');

const MARGIN = 50;
const COLUMN_GAP = 10;

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

// Formats a Date in IST (Asia/Kolkata), not UTC and not the host machine's own
// timezone — CI runners default to UTC with no TZ set, so reading process-local
// components (as this used to) silently rendered UTC in CI while looking correct
// on an IST dev machine. The team is IST-based, so the "Generated at" field and
// the filename derived from it must read IST regardless of where this runs.
function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => {
    const value = parts.find((p) => p.type === type).value;
    // Some ICU data renders midnight as "24" under hour12: false.
    return type === 'hour' && value === '24' ? '00' : value;
  };
  return (
    `${get('year')}-${get('month')}-${get('day')}` +
    `T${get('hour')}:${get('minute')}:${get('second')}`
  );
}

// Formats a millisecond duration as a decimal-seconds string, e.g. 12345 -> "12.3s".
// Used by the ingestion/processing stat cards — raw ms/1000 division can produce
// long, ugly floats (12.345666...) that a stat card has no room to wrap.
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function humanizeFieldName(camelCaseName) {
  const spaced = camelCaseName.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatCitationMatch(entry) {
  if (entry.citationMatches == null) {
    return 'N/A';
  }
  if (entry.citationMatches) {
    return 'YES';
  }
  return `NO (${entry.citationMatchReason})`;
}

// Renders the enum-style riskStatus (RISK_DETECTED / UNSURE / RISK_NOT_DETECTED) for
// display, spacing out the underscores; 'N/A' when missing.
function formatRiskStatus(riskStatus) {
  return riskStatus ? riskStatus.replace(/_/g, ' ') : 'N/A';
}

// RISK_DETECTED is the alarming case (red), RISK_NOT_DETECTED is the clean case
// (green), UNSURE is neither (gray); any other/missing value stays plain black.
function riskStatusColor(riskStatus) {
  if (riskStatus === 'RISK_DETECTED') return 'red';
  if (riskStatus === 'RISK_NOT_DETECTED') return 'green';
  if (riskStatus === 'UNSURE') return 'gray';
  return 'black';
}

function booleanMatchColor(matches) {
  return matches ? 'green' : 'red';
}

function citationMatchColor(entry) {
  if (entry.citationMatches == null) return 'gray';
  return entry.citationMatches ? 'green' : 'red';
}

const RISK_STATUS_ORDER = ['RISK_DETECTED', 'UNSURE', 'RISK_NOT_DETECTED'];

function riskStatusSortKey(riskStatus) {
  const index = RISK_STATUS_ORDER.indexOf(riskStatus);
  return index === -1 ? RISK_STATUS_ORDER.length : index;
}

// Orders questions Detected -> Unsure -> Not Detected (any other/missing risk
// status sorts last) so the highest-risk findings read first in the PDF.
// Array.prototype.sort is stable, so questions sharing a risk status keep
// their original relative order.
function sortByRiskStatus(perQuestionBreakdown) {
  return [...perQuestionBreakdown].sort(
    (a, b) => riskStatusSortKey(a.riskStatus) - riskStatusSortKey(b.riskStatus)
  );
}

// Appends "-2", "-3", ... before the extension until an unused path is found.
// Each generatePdfReports run stamps its filename with the actual time it ran,
// so this only kicks in on the rare case of two runs landing in the same
// second — it's a collision fallback, not the primary way reports differ.
function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}

function drawTableRow(doc, columns, colWidths, { bold = false, colors } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
  const heights = columns.map((text, i) => doc.heightOfString(String(text), { width: colWidths[i] }));
  const rowHeight = Math.max(...heights) + 8;
  if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const startY = doc.y;
  let x = doc.page.margins.left;
  columns.forEach((text, i) => {
    if (colors && colors[i]) {
      doc.fillColor(colors[i]);
    }
    doc.text(String(text), x, startY, { width: colWidths[i] });
    if (colors && colors[i]) {
      doc.fillColor('black');
    }
    x += colWidths[i] + COLUMN_GAP;
  });
  if (bold) {
    doc.font('Helvetica');
  }
  // pdfkit's text() with an explicit x leaves doc.x pinned at the last
  // column's x position (it doesn't restore it), so any subsequent
  // doc.text(...) call made without an explicit x (headings, paragraphs)
  // would otherwise render indented under the last column instead of at
  // the left margin. Reset both cursor coordinates explicitly.
  doc.x = doc.page.margins.left;
  doc.y = startY + rowHeight;
}

// Draws `cards.length` equal-width bordered boxes in a row: a large bold value on
// top, a small label beneath. `color` (optional, per card) tints just the value
// text — e.g. green for a clean success count, red for a nonzero failure count —
// everything else (borders, labels) stays plain black/gray, matching pdfkit's
// existing minimal aesthetic elsewhere in this file (drawTableRow's borders, the
// '#cccccc' question dividers).
function drawStatCardRow(doc, cards) {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 60;
  if (doc.y + cardHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const startY = doc.y;
  cards.forEach((card, i) => {
    const x = doc.page.margins.left + i * (cardWidth + gap);
    doc.rect(x, startY, cardWidth, cardHeight).stroke('#cccccc');
    doc.fontSize(18).font('Helvetica-Bold').fillColor(card.color || 'black')
      .text(String(card.value), x + 8, startY + 10, { width: cardWidth - 16 });
    doc.fontSize(9).font('Helvetica').fillColor('black')
      .text(card.label, x + 8, startY + 36, { width: cardWidth - 16 });
  });
  doc.y = startY + cardHeight + 12;
  doc.x = doc.page.margins.left;
}

function findComponent(gradingResult, metric) {
  return (gradingResult.componentResults || []).find((c) => c.assertion && c.assertion.metric === metric);
}

const REQUIRED_NAMED_SCORES = [
  'riskStatusMatch',
  'answerContentMatch',
  'report_quality',
  'fraudRiskScoreMatch',
  'entityFieldsMatch',
];

function hasRequiredNamedScores(namedScores) {
  return REQUIRED_NAMED_SCORES.every(
    (key) => typeof namedScores?.[key] === 'number' && !Number.isNaN(namedScores[key])
  );
}

// Mirrors the defensive shape-check in scripts/score-dashboard.js: a claim can have a
// bucketId (so it got past the "did the report even get created" check) yet still be
// missing the data renderClaimPdf needs, e.g. a gradingResult that never ran to
// completion, or an ingestion object predating the docsSubmitted/docsComplete counts.
// Skip such claims instead of letting renderClaimPdf throw and abort the whole run —
// the rest of the file's claims should still get their PDFs written.
function isClaimRenderable(result) {
  const output = result.response?.output;
  return Boolean(
    output &&
    output.ingestion &&
    typeof output.ingestion.docsSubmitted === 'number' &&
    typeof output.ingestion.docsComplete === 'number' &&
    output.processing &&
    result.vars?.expected &&
    hasRequiredNamedScores(result.gradingResult?.namedScores)
  );
}

function renderClaimPdf(result, timestamp, filePath) {
  const output = result.response.output;
  const report = output.report;
  const expected = result.vars.expected;
  const namedScores = result.gradingResult.namedScores;
  const qaMatchComponent = findComponent(result.gradingResult, 'qa_match');
  const reportQualityComponent = findComponent(result.gradingResult, 'report_quality');
  const perQuestionBreakdown = (qaMatchComponent && qaMatchComponent.perQuestionBreakdown) || [];
  const failedDocuments = output.failedDocuments || [];

  const bucketId = report.bucketId;
  const accuracy = computeAccuracy(namedScores);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const doc = new PDFDocument({ margin: MARGIN });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(18).text('Claim Eval Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11);
  function topField(label, value) {
    doc.font('Helvetica-Bold').text(label, { continued: true });
    doc.font('Helvetica').text(value);
  }
  topField('Bucket ID: ', String(bucketId));
  topField('Generated at: ', timestamp);
  doc.moveDown();

  // Renders one "Label: value" line with a bold label and a regular-weight
  // value, wrapping within usableWidth like a normal paragraph.
  function field(label, value) {
    doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true, width: usableWidth });
    doc.font('Helvetica').text(value, { width: usableWidth });
    doc.moveDown(0.35);
  }

  // --- Section 1: Document Ingestion ---
  doc.fontSize(14).text('Document Ingestion');
  doc.moveDown(0.5);
  drawStatCardRow(doc, [
    { value: output.ingestion.docsSubmitted, label: 'Docs submitted' },
    { value: output.ingestion.docsComplete, label: 'Docs complete', color: 'green' },
    { value: failedDocuments.length, label: 'Docs failed', color: failedDocuments.length > 0 ? 'red' : 'black' },
    { value: formatSeconds(output.ingestion.timeMs), label: 'Ingestion time' },
  ]);

  if (failedDocuments.length > 0) {
    doc.fontSize(10).font('Helvetica-Bold').text('Failed documents:');
    doc.font('Helvetica');
    doc.moveDown(0.25);
    for (const { fileName, error } of failedDocuments) {
      doc.text(`${fileName}: ${error}`, { width: usableWidth });
    }
    doc.moveDown();
  } else {
    doc.moveDown(0.5);
  }

  // --- Section 2: Claim Processing ---
  doc.fontSize(14).text('Claim Processing');
  doc.moveDown(0.5);
  const processingCards = [
    { value: accuracy, label: 'Accuracy' },
    { value: formatSeconds(output.processing.timeMs), label: 'Processing time' },
    { value: `${Math.round(namedScores.riskStatusMatch * 100)}%`, label: 'Risk status match' },
    { value: `${Math.round(namedScores.answerContentMatch * 100)}%`, label: 'Answer content match' },
  ];
  if (namedScores.citationMatch !== undefined) {
    processingCards.push({ value: `${Math.round(namedScores.citationMatch * 100)}%`, label: 'Citation match' });
  }
  drawStatCardRow(doc, processingCards);

  doc.fontSize(14).text('Question-by-question results');
  doc.moveDown(0.75);

  doc.fontSize(10);
  const qWidths = [130, 60, 90, 202];
  drawTableRow(doc, ['Risk Status', 'Score', 'Risk Match', 'Citation Match'], qWidths, { bold: true });
  doc.moveDown(0.5);

  const orderedQuestions = sortByRiskStatus(perQuestionBreakdown);
  orderedQuestions.forEach((entry, index) => {
    // Full-width flowing paragraphs (no manual x/y column positioning) let pdfkit's
    // automatic pagination handle overflow within each paragraph, so a single
    // question's content stays together in reading order even if it spans a page
    // break — unlike the fixed-column drawTableRow layout above, which tears a
    // wrapped cell's remaining columns onto whatever page the cursor lands on.
    // That row above is short/bounded by design (a formatted enum, a percentage,
    // YES/NO, and formatCitationMatch's short verdict) so it stays safe from that.
    doc.fontSize(11).font('Helvetica-Bold').text(`Q${index + 1}: ${entry.question}`, { width: usableWidth });
    doc.moveDown(0.5);

    doc.fontSize(10);
    drawTableRow(
      doc,
      [
        formatRiskStatus(entry.riskStatus),
        `${Math.round(entry.score)}%`,
        entry.riskStatusMatches ? 'YES' : 'NO',
        formatCitationMatch(entry),
      ],
      qWidths,
      { colors: [riskStatusColor(entry.riskStatus), null, booleanMatchColor(entry.riskStatusMatches), citationMatchColor(entry)] }
    );
    doc.moveDown(0.5);

    const { cleanedText, legend } = formatAnswerWithCitations(entry.actualAnswer);
    field('Answer: ', cleanedText);
    if (legend.length > 0) {
      const sourcesText = `Sources: ${legend.map((l) => `[${l.number}] ${l.fileName}`).join('   ')}`;
      doc.fontSize(9).fillColor('gray').text(sourcesText, { width: usableWidth });
      doc.fillColor('black');
      doc.moveDown(0.35);
    }
    field('Reason: ', entry.reason);

    if (index < orderedQuestions.length - 1) {
      doc.moveDown(0.5);
      doc
        .strokeColor('#cccccc')
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke()
        .strokeColor('black');
      doc.moveDown(0.75);
    } else {
      doc.moveDown();
    }
  });

  doc.fontSize(14).text('Claim metadata match');
  doc.moveDown(0.5);
  doc.fontSize(10);
  const mWidths = [110, 150, 150, 50];
  drawTableRow(doc, ['Field', 'Expected', 'Actual', 'Match'], mWidths, { bold: true });
  drawTableRow(doc, [
    humanizeFieldName('fraudRiskScore'),
    String(expected.fraudRiskScore),
    String(report.fraudRiskScore),
    fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore) ? 'YES' : 'NO',
  ], mWidths);
  const entityRows = [
    ['claimantName', expected.claimantName, report.claimantName],
    ['defendant', expected.defendant, report.defendant],
    ['insuranceFirm', expected.insuranceFirm, report.insuranceFirm],
  ];
  for (const [fieldName, exp, actual] of entityRows) {
    drawTableRow(doc, [humanizeFieldName(fieldName), exp, actual, entitiesMatch(actual, exp) ? 'YES' : 'NO'], mWidths);
  }
  doc.moveDown();

  doc.fontSize(14).text('Overall summary');
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(reportQualityComponent && reportQualityComponent.reason ? reportQualityComponent.reason : '(no report_quality reasoning available)');

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// `now` is injectable so tests can generate a deterministic filename/"Generated
// at" value instead of the real wall-clock time a live run would use.
async function generatePdfReports(resultsFilePath, reportsDir, now = () => new Date()) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const results = parsed.results.results;
  // Stamped once per generatePdfReports call (not once per results.json) so
  // every run of this script — including a re-run against the very same
  // results.json — gets a filename reflecting when it actually ran, instead
  // of reusing the eval's frozen results.timestamp for every regeneration.
  // Uses IST (not UTC, not the host's own timezone) so the filename and the
  // "Generated at" field inside the PDF both read the same regardless of
  // where this script runs.
  const generatedAt = formatLocalTimestamp(now());

  const written = [];
  for (const result of results) {
    const bucketId = result.response?.output?.report?.bucketId;
    if (bucketId === undefined) {
      console.error('Skipping claim unknown: no report was ever produced.');
      continue;
    }
    if (!isClaimRenderable(result)) {
      console.error(`Skipping claim ${bucketId}: missing required data for PDF generation.`);
      continue;
    }
    const fileName = `report-${formatTimestampForFilename(generatedAt)}.pdf`;
    const filePath = uniqueFilePath(path.join(reportsDir, String(bucketId), fileName));
    await renderClaimPdf(result, generatedAt, filePath);
    written.push(filePath);
  }
  return written;
}

function main() {
  const resultsFilePath = process.argv[2] || path.join(process.cwd(), 'results.json');
  const reportsDir = process.argv[3] || path.join(process.cwd(), 'reports');
  generatePdfReports(resultsFilePath, reportsDir)
    .then((written) => {
      for (const filePath of written) {
        console.log(`Wrote ${filePath}`);
      }
      console.log(`Wrote ${written.length} report(s).`);
      // A claim erroring (e.g. a 403 from the FraudX API mid-run) must fail the CI job, not
      // silently produce a green run — even though PDFs for any other, healthy claims in the
      // same results.json were still written above. This is the last step in npm run eval's
      // `;`-chained pipeline, so its exit code becomes the whole command's exit code.
      if (dashboardHasErrors(scoreDashboard(resultsFilePath))) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  formatSeconds,
  humanizeFieldName,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
  formatRiskStatus,
  riskStatusColor,
  booleanMatchColor,
  citationMatchColor,
  drawStatCardRow,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx node --test scripts/generate-pdf-report.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add scripts/generate-pdf-report.js scripts/generate-pdf-report.test.js
git commit -m "feat: restructure the PDF report into Document Ingestion + Claim Processing sections"
```

---

### Task 6: Full verification

This task is pure verification — run it directly, no subagent dispatch needed, per the subagent-driven-development skill's guidance that verification tasks don't need a fresh implementer.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all tests pass (should be noticeably more than the pre-plan count, since Tasks 1-5 each added tests).

- [ ] **Step 2: Stale-reference sweep**

Run: `grep -rln "Risk Status Match:\|Ingestion time: \|Processing time: \|Accuracy: " --include='*.js' --include='*.md' .`
Expected: no matches outside `node_modules` — these are the old preamble/field labels this plan removed; any surviving hit is a missed spot (most likely in `README.md` if it quotes old PDF output verbatim, or a stray comment).

- [ ] **Step 3: Generate a real PDF via the mock server and eyeball it**

```bash
npm run mock-server &
MOCK_PID=$!
sleep 1
SOURCE_BUCKET_ID=31804 FRAUDX_ENDPOINT_URI=http://localhost:4001 \
  CLAIM_NAME=mock-claim INGESTION_MODEL_NAME=mock-ingestion-model PROCESSING_MODEL_NAME=mock-processing-model \
  GRADER_PROVIDER=openai:chat:gpt-4o-mini SKIP_S3_GROUNDING=true \
  npm run eval
kill $MOCK_PID
```

(Match whatever env vars `README.md`'s "Running against the mock server" section currently documents — read it first if any of the above have drifted.)

Expected: the run completes (pass/fail on the mock's deliberately-mismatched data doesn't matter — a `[FAIL]` from scoring is not a pipeline error), and a PDF is written under `reports/<bucketId>/`. Open that PDF (or convert its first couple of pages to text/image) and manually confirm:
- A "Document Ingestion" heading followed by a 4-card stat row, positioned before "Claim Processing".
- A "Claim Processing" heading followed by its own stat card row (4 or 5 cards).
- The Q&A table header row (`Risk Status | Score | Risk Match | Citation Match`) followed by colored per-question rows — Risk Status genuinely colored red/green/gray, Risk Match/Citation Match colored green/red/gray, Score plain black.
- At least one Answer paragraph with a `[n]` marker (not a raw `<InTextCitation>` tag) and a gray "Sources:" line beneath it, if the mock data includes a citation.

Clean up the generated report directory afterward (it's git-ignored scratch from this manual check, not a real eval artifact):

```bash
rm -rf reports/<bucketId-just-generated>
```

- [ ] **Step 4: Update the progress ledger**

```bash
cat >> "$(git rev-parse --show-toplevel)/.superpowers/sdd/progress.md" <<'EOF'

## PDF report restructure plan (2026-08-18-pdf-report-restructure.md)

Task 1: drawStatCardRow + formatSeconds — complete.
Task 2: formatAnswerWithCitations — complete.
Task 3: per-question grader score — complete.
Task 4: docsSubmitted/docsComplete on output.ingestion — complete.
Task 5: renderClaimPdf two-section rewrite — complete.
Task 6: full verification — complete. <fill in actual npm test pass count and confirm the manual PDF check above.>
EOF
```

- [ ] **Step 5: Dispatch the final whole-branch review**

Per `superpowers:subagent-driven-development`, dispatch a final code-reviewer subagent (most capable available model) covering the full commit range for this plan (from the commit immediately before Task 1 through the last commit of Task 5), using `superpowers:requesting-code-review`'s `code-reviewer.md` template and this plan + its spec (`docs/superpowers/specs/2026-08-18-pdf-report-restructure-design.md`) as the requirements reference. Address Critical/Important findings via a fix wave, exactly as was done for the bucket-driven-baseline plan.

- [ ] **Step 6: Hand off**

Once the final review is clean (or its fix wave is applied and re-reviewed), use `superpowers:finishing-a-development-branch` to report status and, on confirmation, push.
