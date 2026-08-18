# PDF Report Restructure: Two Sections + Visual Cleanup

## Goal

Today's PDF (`scripts/generate-pdf-report.js`) is one long flowing document:
a plain-text header (bucket id, ingestion time, processing time, accuracy,
generated-at), then the question-by-question breakdown, then the claim
metadata table, then the overall summary. Ingestion and scoring/QA
information are interleaved with no visual separation.

Reference: `GroundX-Ingestion-Monitoring-Report_2026-08-07.pdf` (an SRE
monitoring report from a different, unrelated system) demonstrates a much
clearer information architecture worth adopting — a compact stat-card grid
for headline numbers, a short narrative "verdict" callout, and clearly
labeled sections — **without** attempting to reproduce its custom branding
(dark gradient hero banner, logo, colored rounded cards with drop shadows).
Per your call: adopt the *structure*, keep pdfkit's existing plain-drawing
style; and only surface ingestion numbers we can actually populate honestly
(we have no GPU/pod/quota/concurrency telemetry — that's a different
system's SRE stack, not ours).

## Decisions

### Two top-level sections

1. **Document Ingestion** — how the source documents copied into the fresh
   bucket, before any claim processing happened.
2. **Claim Processing** — the report itself: per-question Q&A results,
   entity/metadata match, overall summary. This is today's existing content,
   relabeled and regrouped under an explicit section header rather than
   floating unlabeled at the top of the page.

A short preamble above both sections keeps only identity/provenance fields
that belong to neither: report title, Bucket ID, Generated at.

### Reusable stat-card row helper

```js
// Draws `cards.length` equal-width bordered boxes in a row: a large bold
// value on top, a small label beneath. `color` (optional, per card) tints
// just the value text — e.g. green for a clean success count, red for a
// nonzero failure count — everything else (borders, labels) stays plain
// black/gray, matching pdfkit's existing minimal aesthetic elsewhere in
// this file (drawTableRow's borders, the `#cccccc` question dividers).
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

### Section 1: Document Ingestion

Stat-card row, using only data the pipeline actually has:

| Value | Label | Color |
|---|---|---|
| `sourceDocs.length` | Docs submitted | — |
| `sourceDocs.length - failedDocuments.length` | Docs complete | green |
| `failedDocuments.length` | Docs failed | red if > 0, else black |
| `ingestion.timeMs / 1000` (formatted, e.g. `12.3s`) | Ingestion time | — |

Below the card row: if `failedDocuments.length > 0` (per the ingestion-
resilience design in `2026-08-18-bucket-driven-baseline-design.md`), a
"Failed documents" list — one line per entry, `fileName: error`. Omitted
entirely (no heading, no empty box) when there are none, so a clean run's
report doesn't grow a section for something that didn't happen.

`output.ingestion` gains the two new counts needed here — `provider.js`
already knows `sourceDocs.length` and (after the ingestion-resilience
change) `failedDocuments.length` at the point it builds `output`:

```js
ingestion: {
  timeMs: ingestionTimeMs,
  docsSubmitted: sourceDocs.length,
  docsComplete: sourceDocs.length - failedDocuments.length,
},
```

(`docsFailed` is `failedDocuments.length`, read directly off the
already-planned `output.failedDocuments` rather than duplicated onto
`ingestion` too.)

### Section 2: Claim Processing

Stat-card row using today's existing dashboard numbers, now placed under an
explicit heading instead of a bare header:

| Value | Label |
|---|---|
| `accuracy` | Accuracy |
| `processing.timeMs / 1000` (formatted) | Processing time |
| `namedScores.riskStatusMatch` (formatted as a %) | Risk status match |
| `namedScores.answerContentMatch` (formatted as a %) | Answer content match |

`citationMatch` is a 5th card only when defined (`namedScores.citationMatch
!== undefined`) — the row helper takes a plain array, so a variable card
count (4 or 5) is just a longer/shorter array, no special-casing in the
helper itself.

Then, in order: the existing per-question breakdown (reformatted below),
the existing claim-metadata table (unchanged content, just moved under this
section's heading), the existing overall-summary paragraph (unchanged).

### Q&A breakdown: real bordered table row + a new per-question score

Per your calls: **literal table**, but only for the short, bounded fields —
Answer and Reason stay full-width paragraphs below the row, in the same
bordered block, so a long answer overflowing onto a new page can't tear
sibling columns apart (the exact bug the original 2026-08-13 design avoided
by going flowing-paragraph in the first place; this keeps that safety for
the genuinely long fields while making the short fields a real table).

Per-question layout becomes:

1. **Question heading** — `Q{n}: {question}`, unchanged, full width.
2. **A 4-column bordered row** — `Risk Status | Score | Risk Match |
   Citation Match` — built with `drawTableRow`, the same helper the
   claim-metadata table already uses for exactly this safe case (short,
   single-line, bounded values, never at risk of the pagination-tearing
   bug). `drawTableRow` itself gains one small addition: an optional
   per-column `colors` array (`{ bold, colors }`, alongside its existing
   `{ bold }` option) — `colors[i]` sets `doc.fillColor` before drawing
   column `i`'s text, reset to `'black'` after, for the 3 of these 4 columns
   that need color. The claim-metadata table's own existing calls are
   unaffected (they simply don't pass `colors`, same as they don't pass
   `bold: true` today except for the header row).
   - **Risk Status**: the question's actual `riskStatus` (`RISK DETECTED` /
     `UNSURE` / `RISK NOT DETECTED`), colored red / gray / green. New
     *visible* information — today's PDF never shows what the risk status
     actually *was*, only whether it matched the expected one.
   - **Score**: the new per-question numeric score (below), formatted as
     `{score}%`, uncolored (a plain number, not a pass/fail signal).
   - **Risk Match**: `riskStatusMatches`, colored green `YES` / red `NO`.
   - **Citation Match**: `formatCitationMatch(entry)`'s existing output
     (`YES` / `NO (reason)` / `N/A`), colored green/red/gray respectively,
     reason text unchanged.
3. **Answer** (with cleaned-up citations, see below) and **Reason** —
   full-width paragraphs, exactly as today, directly below the row.

### New per-question numeric score (`scripts/qa-match-assertion.js`)

There's currently no per-question numeric score anywhere — only three
independent booleans (`riskStatusMatches`, `answerContentMatch`'s `matches`,
`citationMatches`). Per your choice, the grader itself now returns a real
0-100 confidence score alongside its existing boolean verdict, in the same
call (no new LLM call, no added latency/cost):

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

**`parseGraderVerdict` treats `score` as optional**, not required — this
function is shared with the citation-text grader call
(`matchesAnyResolvedChunk`'s `buildChunkTextMatchPrompt`), whose prompt does
*not* ask for a score and never will (it's a different judgment — "does
this passage support this citation," not "how good is this answer"). Making
`score` unconditionally required would break every citation-match grader
response, which has no `score` field at all.

```js
function parseGraderVerdict(responseOutput) {
  const text = typeof responseOutput === 'string' ? responseOutput : JSON.stringify(responseOutput);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not find a JSON object in grader response: ${text}`);
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

`qaMatchAssertion`'s per-question loop carries `score` into
`perQuestionBreakdown` alongside the existing fields — no other change to
that function's body.

**Decision: additive, not a replacement.** `answerContentMatch` (the
aggregate) keeps its exact current computation —
`perQuestionBreakdown.filter((v) => v.matches).length / perQuestionBreakdown.length`,
still boolean-based. The new `score` is a richer per-question display value
only; it does not feed `answerContentMatch`, `computeAccuracy`, or any
threshold/pass-fail logic. Changing the aggregate to average raw scores
instead of counting booleans would ripple into CI-gating behavior (pass/fail
thresholds, `computeAccuracy`'s weighting) — out of scope here, since the
ask was a report column, not a scoring-methodology change.

### Citation link formatting

Today, `Answer:` renders `entry.actualAnswer` verbatim — raw
`<InTextCitation url="..." fileName="..." documentId="..." chunkId="..."
...></InTextCitation>` tags dumped straight into the prose. Per your call:
each tag becomes a small numbered inline marker (`[1]`, `[2]`, ...,
deduplicated by source and numbered in order of first appearance — reusing
`extractCitedCitationsFromText`'s existing dedup/ordering exactly), with a
short legend below the answer mapping each number to its `fileName`.

New function in `src/lib/extract-cited-file-names.js` (a natural sibling of
`extractCitedCitationsFromText`, not a new file — same subject matter):

```js
// Full open+close tag pair, unlike extractCitedCitationsFromText's TAG_REGEX
// (which only needs the opening tag's attributes to extract data) — here the
// *entire* tag, including its closing </InTextCitation>, must be matched and
// removed, or the literal closing-tag text would be left behind in the
// cleaned prose.
const FULL_TAG_REGEX = /<InTextCitation\b([^>]*)><\/InTextCitation>/g;

// Replaces every citation tag in `text` with a small inline [n] marker —
// same source cited twice reuses the same number — and returns an ordered
// legend for the sources actually referenced, for a short "Sources:" line
// below the answer. A tag missing fileName/documentId/chunkId (the same
// "useless downstream" case extractCitedCitationsFromText already skips) is
// removed with no marker, rather than left as raw markup.
function formatAnswerWithCitations(text) {
  if (!text) return { cleanedText: text, legend: [] };
  const citations = extractCitedCitationsFromText(text);
  const numberByKey = new Map(citations.map((c, i) => [`${c.documentId}:${c.chunkId}`, i + 1]));

  FULL_TAG_REGEX.lastIndex = 0;
  const cleanedText = text.replace(FULL_TAG_REGEX, (whole, attrs) => {
    const fileName = FILE_NAME_ATTR_REGEX.exec(attrs);
    const documentId = DOCUMENT_ID_ATTR_REGEX.exec(attrs);
    const chunkId = CHUNK_ID_ATTR_REGEX.exec(attrs);
    if (!fileName || !documentId || !chunkId) return '';
    const n = numberByKey.get(`${documentId[1]}:${chunkId[1]}`);
    return n ? `[${n}]` : '';
  });

  const legend = citations.map((c, i) => ({ number: i + 1, fileName: c.fileName }));
  return { cleanedText, legend };
}
```

`FILE_NAME_ATTR_REGEX`/`DOCUMENT_ID_ATTR_REGEX`/`CHUNK_ID_ATTR_REGEX` are the
same three attribute regexes `extractCitedCitationsFromText` already uses
internally — exported alongside the two functions rather than redefined, so
there is exactly one place that knows how to pull `fileName`/`documentId`/
`chunkId` out of a tag's attribute string.

`scripts/generate-pdf-report.js` calls `formatAnswerWithCitations(entry.actualAnswer)`
instead of passing `entry.actualAnswer` straight to `field('Answer: ', ...)`,
renders `cleanedText` as the answer paragraph, then — only when
`legend.length > 0` — a small `Sources: [1] a.pdf   [2] b.pdf` line
immediately below it in a smaller, gray font (visually secondary to the
answer itself, matching how citation reasons already render smaller/inline
elsewhere in this file).

### Color palette (kept minimal, no new dependency)

Reuses pdfkit's built-in named colors only (`'green'`, `'red'`, `'gray'`,
`'black'`) — no hex palette, no gradients, matching the "adopt structure not
branding" decision. `doc.fillColor(...)` before text, reset to `'black'`
immediately after each colored fragment (pdfkit's fill color is stateful
across calls, same gotcha the existing code already navigates for
`doc.x`/`doc.y` — see `drawTableRow`'s comment on this).

## Testing

- `scripts/generate-pdf-report.test.js`:
  - `drawStatCardRow` renders N cards' values and labels, re-parsed via
    `pdf-parse` (same technique every existing PDF-content test already
    uses).
  - Document Ingestion section: docs submitted/complete/failed counts and
    ingestion time appear; a claim with `failedDocuments` renders the
    "Failed documents" list with each `fileName`/`error`; a claim with none
    renders no such heading at all (assert the heading text does *not*
    appear).
  - Claim Processing section: existing accuracy/processing-time assertions
    move under this section's heading; a 5th citationMatch card appears
    only when `namedScores.citationMatch !== undefined`.
  - Q&A section: the 4-column row (`Risk Status`/`Score`/`Risk Match`/
    `Citation Match`) renders correct values and colors per question;
    `Risk Status` shows the question's actual `riskStatus`, distinct from
    whether it *matched*; the Answer paragraph shows numbered `[n]` markers,
    not raw `<InTextCitation>` tags; a "Sources:" line appears listing each
    marker's `fileName` when the answer has any citations, and is entirely
    absent when it has none.
  - Existing tests for `formatCitationMatch`, `sortByRiskStatus`,
    `uniqueFilePath`, `formatTimestampForFilename`, `formatLocalTimestamp`,
    `humanizeFieldName` are unchanged — none of their behavior changes,
    only where their output gets placed on the page.
- `src/lib/extract-cited-file-names.test.js`:
  - `formatAnswerWithCitations` replaces each tag with its `[n]` marker, in
    order of first appearance; a source cited twice reuses the same number
    (only one legend entry, two markers in the text); a tag missing
    `fileName`/`documentId`/`chunkId` is removed with no marker (matching
    `extractCitedCitationsFromText`'s existing skip behavior); no tags in
    the input returns the text unchanged and an empty legend; `null`/`''`
    input returns `{ cleanedText: input, legend: [] }` without throwing.
- `src/lib/qa-match-assertion.test.js`:
  - `parseGraderVerdict` accepts a response with `score` (0-100) and returns
    it; accepts a response *without* `score` (the citation-grading shape)
    and returns `score: undefined`, still validating `matches`/`reason` as
    before; throws when `score` is present but out of range or non-numeric.
  - `qaMatchAssertion`'s `perQuestionBreakdown` carries the grader's `score`
    through per question; `answerContentMatch` (the aggregate) is unaffected
    by `score`'s presence — still the same `matches`-boolean fraction as
    every existing test already asserts.

## Out of scope

- No attempt to reproduce the reference report's actual visual branding
  (colors, logo, rounded corners, dark hero banner) — explicitly rejected in
  favor of adopting its information architecture within pdfkit's existing
  plain style.
- No new ingestion telemetry beyond docs submitted/complete/failed and
  ingestion time — we have no GPU/pod/quota/concurrency data to show,
  regardless of what the reference report displays.
- No charts/graphs (the reference's throughput-over-time and per-step-timing
  charts) — nothing in this pipeline's data supports them (no time-series
  telemetry, only start/end timestamps for two coarse phases).
- No change to `answerContentMatch`'s aggregate computation,
  `computeAccuracy`'s weighting, or any threshold/pass-fail logic — the new
  per-question `score` is display-only (see "additive, not a replacement"
  above).
- No change to `results.json`'s stored `actualAnswer` — `perQuestionBreakdown`
  keeps the raw answer text with citation tags intact (still needed for
  `citationMatch` grading, which reads citations off the raw text).
  `formatAnswerWithCitations` runs only at PDF-render time, in
  `generate-pdf-report.js`; it produces a display copy, not a stored one.
