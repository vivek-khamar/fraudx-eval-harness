# PDF Report Redesign: HTML-Templated, Headless-Rendered, Narrative-Enriched

## Goal

Replace the current pdfkit-drawn PDF (`scripts/generate-pdf-report.js`,
restructured most recently in `2026-08-18-pdf-report-restructure-design.md`)
with a PDF built from the real HTML/CSS/SVG design in the reference file
`/home/vivek/Downloads/claim_eval_report.html` — navy/lime branding, KPI
cards, ingestion/processing/accuracy sections with SVG charts, a narrative
"Final Verdict" section, a detailed results table, a claim-metadata table,
and a full per-question Q&A appendix with hyperlinked sources.

This supersedes the 2026-08-18 restructure spec's pdfkit-drawing approach
entirely — that design's "adopt structure, not branding" and "no charts"
decisions are explicitly reversed here per your direction: the new report
should look **identical** to the reference, branding included.

The output stays a single PDF per claim, at the same location
(`reports/<bucketId>/report-<timestamp>.pdf`) — no separate HTML file is
generated or stored. HTML is only ever an in-memory rendering step.

## Architecture

```
results.json
   │
   ▼
scripts/generate-pdf-report.js  (rewritten orchestrator)
   │
   ├─▶ src/lib/narrative-analysis.js   — one LLM call per claim → narrative prose
   │
   ├─▶ src/lib/html-report-template.js — builds one complete HTML string
   │       (reuses the reference's CSS verbatim; ports its SVG-chart math
   │        to Node functions; computes all numbers deterministically from
   │        results.json — the LLM never invents a number)
   │
   └─▶ Puppeteer (headless Chromium)
           page.setContent(html) → page.pdf() → reports/<bucketId>/report-<ts>.pdf
```

Three new/changed pieces:

1. **`src/lib/narrative-analysis.js`** (new) — the one new LLM call, for
   prose only.
2. **`src/lib/html-report-template.js`** (new) — pure function(s) from
   computed claim data + narrative data → HTML string. No I/O, no network —
   fully unit-testable as string assertions.
3. **`scripts/generate-pdf-report.js`** (rewritten) — same CLI/module
   surface (`generatePdfReports(resultsFilePath, reportsDir, now)`,
   `main()`), but its internals go from pdfkit drawing calls to: compute →
   narrative → template → Puppeteer print. `pdfkit` is removed from
   `package.json`; `puppeteer` is added.

## Decisions

### The LLM narrative call never invents numbers

Every chart, stat card, and table in the report is computed deterministically
in `html-report-template.js` from fields already in `results.json`
(`namedScores`, `perQuestionBreakdown`, `report`/`expected` metadata,
`output.ingestion`/`output.processing`). The narrative LLM call's prompt is
handed these already-computed numbers and is asked only to write prose that
*interprets* them — bullet points, a one-line verdict per question, and the
Final Verdict essay. This keeps every number in the report reproducible and
trustworthy regardless of what the grader model says; only the words around
the numbers come from the LLM.

### Per-question data: one field to add

`perQuestionBreakdown` (built in `qaMatchAssertion`, `src/lib/qa-match-assertion.js`)
already carries `riskStatus`, `riskStatusMatches`, `score`,
`citationMatchScore`, `reason`, `actualAnswer`, `predefinedQuestionId`. It is
missing the expected risk status itself (only the boolean match is stored) —
needed for the reference's "Expected Output" chip per question and for the
risk-distribution chart (model output vs. gold expected). `q.expectedRiskStatus`
is already available in the loop that builds this array; it's a one-line
addition:

```js
perQuestionBreakdown.push({
  predefinedQuestionId: q.predefinedQuestionId,
  question: q.question,
  actualAnswer,
  riskStatus,
  expectedRiskStatus: q.expectedRiskStatus,   // new
  riskStatusMatches,
  matches,
  reason,
  score,
  actualCitedFileNames,
  citationMatches,
  citationMatchReason,
  citationMatchScore,
});
```

No other field changes. `citationMatchReason` stays computed and stored as
today (per the earlier citationMatchScore work) even though the PDF now
shows a percentage, not the reason text, in the compact places — the reason
is still available for anyone reading `results.json` directly.

### Deterministic verdict color (`vk`), no LLM needed

The reference's per-question verdict-line color (good/mid/bad) reduces to a
simple rule that reproduces every row in the reference's own sample data:

```js
function verdictKind(entry) {
  if (!entry.riskStatusMatches) return 'bad';
  return entry.score >= 80 ? 'good' : 'mid';
}
```

### `src/lib/narrative-analysis.js`

One function, `generateNarrativeAnalysis(provider, claimSummary)`, called
once per claim from `generate-pdf-report.js`. `provider` is the same
`promptfoo.loadApiProvider(process.env.GRADER_PROVIDER)` instance already
used by `qa-match-assertion.js` — no new env var, no new provider-loading
code.

`claimSummary` is a plain object built by the caller from already-computed
data:

```js
{
  namedScores,                 // riskStatusMatch, answerContentMatch, citationMatch, fraudRiskScoreMatch, entityFieldsMatch
  riskDistribution: { model: {det, nd, ns}, gold: {det, nd, ns} },
  semanticByGoldCategory: [{ category: 'det'|'nd'|'ns', count, avgScore }],
  metadataMatch: [{ field, expected, actual, matches }],
  questions: perQuestionBreakdown.map(q => ({
    id: q.predefinedQuestionId,
    question: q.question,
    expectedRiskStatus: q.expectedRiskStatus,
    riskStatus: q.riskStatus,
    riskStatusMatches: q.riskStatusMatches,
    score: q.score,
    citationMatchScore: q.citationMatchScore,
    reason: q.reason,
    // capped so 35 questions' worth of answers keeps the prompt a bounded size —
    // the reason field already carries the substantive comparison; the answer
    // excerpt is context, not the primary signal
    actualAnswerExcerpt: q.actualAnswer.slice(0, 600),
  })),
}
```

The prompt (built by `buildNarrativePrompt(claimSummary)`) lists these
figures explicitly and asks for a single JSON response:

```
{
  "summaryPanel": string[],       // 3-5 bullets, "Summary" panel
  "questionsPanel": string[],     // 3-5 bullets, "Questions" panel
  "citationsPanel": string[],     // 3-5 bullets, "Citations" panel
  "overallPanel": string[],       // 3-5 bullets, "Overall" panel
  "finalVerdict": {
    "netRead": string[],          // 3-6 bullets
    "whatWentRight": string[],    // 2-5 bullets
    "whatWentWrong": string[],    // 2-5 bullets
    "reasoning": string           // one paragraph
  },
  "perQuestionVerdicts": { "<questionId>": string, ... }  // one line each, every question id present
}
```

Parsing (`parseNarrativeResponse`) follows the same shape as
`qa-match-assertion.js`'s existing `parseGraderVerdict`: regex out the first
`{...}` block, `JSON.parse`, then validate required keys/types are present
(all four panel arrays, `finalVerdict`'s four sub-fields, and that
`perQuestionVerdicts` has an entry for every question id passed in) —
throwing a descriptive error on anything missing, exactly like the existing
grader-response validation.

### Fallback when the narrative call fails or the response is malformed

`generate-pdf-report.js` wraps the `generateNarrativeAnalysis` call in
try/catch per claim. On failure (network error, malformed JSON, missing
keys), it substitutes a fixed fallback object with placeholder text
("Narrative analysis unavailable for this run.") in every prose slot and an
empty string for each question's one-liner — then renders the rest of the
report normally. One claim's LLM hiccup never aborts the whole
`generatePdfReports` run, matching the existing `isClaimRenderable`
skip-not-abort philosophy already in this file.

### `src/lib/html-report-template.js`

Exports `renderReportHtml(claimData)`, a pure function returning a complete
HTML document string. Internally:

- A single template-literal constant holds the reference's `<style>` block
  verbatim (colors, cards, chips, tables, `@media print` rules already
  present in the source file — it was evidently authored with print-to-PDF
  in mind, since it already includes `break-inside:avoid` and background-
  printing rules).
- Chart-building functions ported 1:1 from the reference's client-side
  `<script>` (same math — bucketing, bar widths, SVG path/rect coordinates —
  just called at HTML-build time in Node instead of at page-load time in a
  browser): `renderRiskStatusMatchBar`, `renderRiskDistributionChart`,
  `renderSemanticHistogram`, `renderSemanticByGoldCategoryChart`. Each
  takes the already-computed arrays (no DOM, no client JS in the output at
  all — the final HTML has zero `<script>` tags, everything is rendered
  markup).
- Per-question cards reuse `formatAnswerWithCitations` (existing, in
  `src/lib/extract-cited-file-names.js`) for the cleaned answer text +
  grouped, real `<a href>` source links — Chromium's print-to-PDF turns
  these into real clickable PDF link annotations for free, replacing the
  manual pdfkit link-segment chaining that exists today.
- The `META` claim-metadata table reuses `entitiesMatch` and
  `fraudRiskScoreMatches` from `src/lib/metadata-match-assertion.js`,
  exactly as today.

### PDF rendering: Puppeteer

`generate-pdf-report.js`'s render step becomes:

```js
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox'], // needed in most CI containers
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
await browser.close();
fs.writeFileSync(filePath, pdfBuffer);
```

`margin: 0` on all four sides is deliberate — the reference CSS already
provides its own page whitespace via `.wrap`'s `max-width:900px;margin:0
auto;padding:28px 22px 80px`; Puppeteer's own default page margins would
otherwise stack on top of that padding, roughly doubling the report's outer
whitespace.

One browser instance is launched and reused across all claims in a single
`generatePdfReports` call (not one launch per claim) — Chromium startup is
the expensive part, and a single results.json run's claims can share one
browser process, each getting its own `page`.

### Dependency change

- Remove: `pdfkit` (no longer used anywhere once this rewrite lands)
- Add: `puppeteer` (bundles its own Chromium — no separate browser install
  step needed on a dev machine)

**CI risk to verify during implementation:** GitHub Actions'
`ubuntu-latest` runner usually works with Puppeteer's bundled Chromium out
of the box, but headless Chromium occasionally needs the `--no-sandbox`
flag (included above) and/or a few missing shared libraries in minimal CI
containers. The implementation plan must include actually running the
eval-workflow CI job (or a reasonable local approximation, e.g. a
container matching the runner image) after this change lands, with a
documented fallback (apt-get the missing shared libs in
`.github/workflows/eval-workflow.yml`) if Chromium fails to launch there.

## Testing

- `src/lib/narrative-analysis.test.js`:
  - `buildNarrativePrompt` includes every computed figure passed in
    (spot-check a few: `namedScores.riskStatusMatch`, a specific question's
    `score`, the risk-distribution counts) and every question's id.
  - `parseNarrativeResponse` accepts a well-formed response and returns the
    parsed object; throws when any of the four panel arrays is missing;
    throws when `finalVerdict` is missing a required sub-field; throws when
    `perQuestionVerdicts` is missing an entry for a question id that was in
    the input.
  - `generateNarrativeAnalysis` calls `provider.callApi` exactly once with
    the built prompt and returns the parsed result (mocked provider, no
    real network call).
- `src/lib/html-report-template.test.js`:
  - `renderReportHtml` output contains the bucket id, claimant name,
    generated-at timestamp, and every KPI percentage.
  - Each chart-building function returns SVG markup containing the correct
    bar proportions/counts for a small hand-computed fixture (e.g. 2 of 3
    matched → a specific width ratio).
  - Per-question cards: the risk chip reflects `riskStatus`, the verdict
    line's CSS class matches `verdictKind(entry)`, the answer text has no
    raw `<InTextCitation>` tags (only `[n]` markers, reusing existing
    `formatAnswerWithCitations` behavior/tests), and the sources list is a
    real `<a href="...">` per distinct source file.
  - Claim-metadata table: match/no-match rendering matches
    `entitiesMatch`/`fraudRiskScoreMatches` output for known fixture pairs.
  - A claim whose narrative data is the fallback placeholder still renders
    every section without throwing (no section assumes narrative fields are
    non-empty).
- `scripts/generate-pdf-report.test.js` (rewritten):
  - `generatePdfReports` on a small fixture `results.json` produces a real
    PDF file (`fs.existsSync`, starts with `%PDF`) at the expected path.
  - Using `pdf-parse` (still applicable — Chromium embeds real selectable
    text, not images), the produced PDF's extracted text contains a few
    expected strings (bucket id, a question's text, the accuracy percentage)
    — a coarse content check, not a full re-verification of every unit test
    already covered at the `html-report-template` layer.
  - A claim where the narrative call is mocked to fail still produces a
    valid PDF (fallback path, no crash).
  - Existing `formatTimestampForFilename`, `formatLocalTimestamp`,
    `uniqueFilePath`, `sortByRiskStatus` helpers are unchanged in behavior
    and keep their existing tests (they don't depend on the rendering
    mechanism, only on filenames/ordering).

## Out of scope

- No separate HTML file is ever written to disk — the HTML string is
  build-time-only, in memory, discarded after `page.pdf()` runs.
- No per-step processing-time telemetry — the pipeline still only emits
  total ingestion/processing time, so the "Per-step processing breakdown"
  table stays all `N/A`, exactly as the reference itself already shows for
  data it doesn't have.
- No change to `answerContentMatch`, `citationMatch`, `riskStatusMatch`,
  `computeAccuracy`, or any pass/fail threshold logic — this is a rendering
  and narrative-prose change only, not a scoring-methodology change.
- No change to what's stored in `results.json` — `perQuestionBreakdown`
  gains one additive field (`expectedRiskStatus`); nothing existing is
  removed or reshaped.
- No retry/backoff logic on the new narrative LLM call beyond what
  `provider.callApi` itself does — a failure goes straight to the fallback
  placeholder, matching how the existing per-question grader calls behave
  on error (`qaMatchAssertion` throws immediately on `response.error`, no
  retry).
