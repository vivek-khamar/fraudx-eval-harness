# fraudx-claim-eval

A standalone promptfoo eval that runs one or more immutable "golden claims" through the FraudX
document-ingestion + report pipeline and scores each against a human-verified answer key.

## Design

- **The provider is blind to the answer key.** `provider.js` only ever reads
  `context.vars.bucket`. It never touches
  `context.vars.expected`. This is enforced by a unit test in `provider.test.js` —
  if the pipeline's retrieval context could ever see the gold answers, "accuracy"
  would be meaningless.
- **The eval triggers real work, nothing is simulated.** `provider.js` calls your
  actual ingestion and processing endpoints and times them with its own stopwatch.
  If you have 20 golden claims, that's 20 full pipeline runs, not a mock. Each
  call is bounded by an `AbortSignal` timeout, configurable via
  `FRAUDX_HTTP_TIMEOUT_MS` (default 900000ms), so a hung endpoint can't block
  the eval forever.
- **Time never enters a promptfoo assertion.** Ingest time and processing time are
  just fields on the provider's output, already timed by the time promptfoo sees
  them. `scripts/score-dashboard.js` reports them as-is — no budget or percentage
  math, just the raw millisecond values.
- **Accuracy is graded inside promptfoo**, via three assertions applied to every test case (one
  per golden claim): `qa_match`, `report_quality`, and `metadata_match`.
  - `qa_match` (`javascript`, `scripts/qa-match-assertion.js`) computes two independent signals
    and reports both as named scores from a single assertion:
    - `riskStatusMatch` (deterministic): the fraction of that claim's predefined questions whose
      `riskStatus` exactly matches the gold `expectedRiskStatus`.
    - `answerContentMatch` (LLM-graded): one rubric call PER QUESTION (not one batched call for
      all of a claim's questions) that judges that question's actual answer text against its gold
      `expectedAnswerSummary` for semantic (not exact-wording) match, and returns the fraction of
      questions that match. The assertion also returns a `perQuestionBreakdown` array — one entry
      per question with its `predefinedQuestionId`, `question`, `actualAnswer`, `matches`
      (boolean), and `reason` (the grader's per-question reasoning) — which is what
      `scripts/generate-pdf-report.js` renders in the question-by-question section of the PDF.
    The assertion's own score is the average of the two; `pass` defaults to `score > 0` unless
    a `threshold` is set on the `qa_match` assert entry in `promptfooconfig.yaml`.
  - `report_quality` (`llm-rubric`) judges the report's summary against the gold summary and
    `citedDocumentsText` (fetched by `provider.js`, never from the answer key — see below) on
    completeness, clinical correctness, missing information, and groundedness (whether every claim
    in the summary is actually supported by the cited source text, with no hallucination) — a
    single 0–1 score covering all of that.
  - `metadata_match` (`javascript`, `scripts/metadata-match-assertion.js`) checks the real report's
    claim-level metadata against new `expected*` fields in `testdata/claims.json`, and reports two
    named scores:
    - `fraudRiskScoreMatch`: 1 if the real report's `fraudRiskScore` is within ±0.1 of the gold
      `expectedFraudRiskScore`, else 0.
    - `entityFieldsMatch`: the fraction of `claimantName`, `defendant`, and `insuranceFirm` that
      match their `expected*` counterpart exactly, case- and whitespace-insensitively.
  `scripts/score-dashboard.js` (via its exported `computeAccuracy(namedScores)`, also reused by
  `scripts/generate-pdf-report.js` so the two never drift apart) combines all five named scores as
  equal fifths:
  `acc = round(20×riskStatusMatch + 20×answerContentMatch + 20×report_quality + 20×fraudRiskScoreMatch + 20×entityFieldsMatch)`.
  `acc` numbers from before this scoring change (three signals, equal thirds) are not directly
  comparable to `acc` numbers after it (five signals, equal fifths) — the weighting and underlying
  signals both changed.
  The grading provider is read directly from `GRADER_PROVIDER` in `.env` — there's no hardcoded
  default, so `GRADER_PROVIDER` must be set. That provider's own API key must also be set.
- **`provider.js` fetches the text of every document the real report actually cites** (not the
  whole source bucket, and never based on the gold answer key) and attaches it as
  `output.citedDocumentsText`, capped at 15,000 characters per document — this is what
  `report_quality` checks the summary's claims against. If the report cites a filename
  `provider.js` can't match to a real source document, that citation is skipped rather than
  failing the run.
- **The provider recreates the claim from scratch on every run.** `provider.js` logs in, downloads every document from the golden claim's frozen source bucket, creates a brand-new claim/bucket, and re-uploads them there — this untimed setup step exists because the FraudX platform processes per-claim, and each eval run needs its own fresh claim to submit against.
- **`provider.js` times ingestion and report-generation as two independent phases, and the dashboard reports them independently too.** With `skipGxProcess: false`, each document's own GX ingestion completes individually during the upload loop (`fileMetrics.completedFiles` reaches 5/5 before claim-level processing is ever triggered), so `provider.js` times that whole per-document loop — start of the first document to end of the last — as `ingestion.timeMs`. Separately, it times `triggerClaimProcessing` (the trigger) to `waitForClaimProcessing` resolving (`bucketStatus` reaching `SUCCESS`, i.e. the report is ready) as `processing.timeMs`. `dashboard.ingestionTime` and `dashboard.processingTime` are just those two raw values converted from milliseconds to seconds, unchanged and uncombined otherwise.
- **Citations are parsed out of free-text answers.** The real report embeds citations as inline `<InTextCitation fileName="...">` tags inside each answer's text, not a structured field — `provider.js`'s `extractCitedFileNames` regex-extracts them (to decide which documents to fetch text for), and `report_quality` checks claims against that fetched text rather than matching on filename alone.
- **`npm run score` (and therefore `npm run eval`) also writes a PDF report per scoreable claim.**
  `scripts/generate-pdf-report.js` reads the same `results.json` as the console dashboard and
  writes one PDF per claim that has a `bucketId` and passes its own renderability check, to
  `reports/<bucketId>/report-<timestamp>.pdf`, where `<timestamp>` is the *local* time (not
  UTC) that PDF-generation run actually happened (not the eval's own `results.timestamp`) — so
  re-running against the same `results.json` adds a new, distinctly timestamped file alongside
  any earlier ones instead of overwriting them. On the rare case of two runs landing in the same
  second, a numeric suffix (`-2`, `-3`, ...) is appended as a fallback. The PDF opens with a
  centered "Claim Eval Report" title and a field list (bucket ID, ingestion time, processing
  time, accuracy, and "Generated at" — the same local timestamp used in the filename, labeled
  "(local time)" so it's never mistaken for UTC), then the question-by-question breakdown —
  questions are numbered sequentially (Q1, Q2, ...) and ordered by risk status (Detected, then
  Unsure, then Not Detected) rather than by their original ID, so the highest-risk findings read
  first. Each block has a heading followed by labeled Risk Status, Match, Answer, and Reason
  fields, separated by a divider between questions, laid out as full-width flowing paragraphs so
  a single question's content stays together in reading order even across a page break; the
  redundant "RISK ...:" prefix the real report embeds at the start of each answer is stripped
  since risk status now has its own field. After that comes the claim-metadata match table
  (`fraudRiskScore` and the three entity fields, expected vs. actual — field names are
  humanized for display, e.g. `fraudRiskScore` reads as "Fraud Risk Score") and an overall
  summary. A claim that gets skipped (no `bucketId`, or missing the data the PDF needs) is
  logged via `console.error` with its `bucketId` and a reason, and `main()` prints a final
  `Wrote N report(s).` summary line, so a run that produces zero PDFs is never silent.

## Setup

```bash
npm install
cp .env.example .env   # fill in FRAUDX_ENDPOINT_URI and ANTHROPIC_API_KEY
```

## Running against the real FraudX platform

```bash
npm run eval
```

- `npm run eval` runs `npm run eval:raw` (which runs `promptfoo eval` against
  `FRAUDX_ENDPOINT_URI`, grades the result, and writes `results.json`) and then
  `npm run score`. `--no-cache` is required — promptfoo caches provider responses
  by default, and a cached "response" would mean `provider.js` never actually
  calls your endpoint on a re-run, silently returning stale timing data that would
  make a real regression invisible. `--max-concurrency 1` runs multiple golden
  claims one at a time, not in parallel — the real platform has shared,
  account-level ingestion limits (e.g. a cap on concurrently-ingesting files),
  so running claims concurrently risks them contending with each other for that
  same quota.
- `npm run score` reads `results.json` and prints one dashboard object per claim:

```json
[
  {
    "bucketId": 31662,
    "ingestionTime": 71,
    "processingTime": 184,
    "accuracy": 94
  },
  {
    "bucketId": 31970,
    "ingestionTime": 53,
    "processingTime": 96,
    "accuracy": 68
  }
]
```

`bucketId` identifies the real, newly-created FraudX bucket this run produced for that golden
claim (read from `output.report.bucketId`, i.e. only available once the report was actually
fetched) — not the golden claim's frozen source bucket. If the provider call failed before a
report was ever fetched (e.g. claim creation itself failed), that entry has no `bucketId` at all;
the `error` text is the only record of what happened.

If a claim's provider call errored (e.g. a platform outage, a bad model ID for the current
environment) or its accuracy score came out `NaN`, that claim's entry has an `error` field
instead of the three numbers — it does not stop the other claims in the same run from being
scored. A claim can still be fully scored even if `results.json` marks it as errored overall —
promptfoo sets that top-level error to a human-readable summary whenever any assertion's own
`pass` verdict is false (e.g. `report_quality`'s LLM judge deciding a summary is incomplete),
which doesn't mean the pipeline or scoring actually failed.

`ingestionTime` and `processingTime` are raw seconds (ingestion phase alone, and report-generation phase alone, respectively) — not scores or percentages.

`npm run score` also runs `scripts/generate-pdf-report.js` against the same `results.json`,
writing `reports/<bucketId>/report-<timestamp>.pdf` for each claim it can render (see the PDF
report bullet above) — so a normal `npm run eval` run leaves you with both the console dashboard
and one PDF report per claim.

## Running the unit tests

```bash
npm test
```

## Trying it locally without hitting real infra

A mock server stands in for the FraudX ingest/process endpoints so you can see the
whole pipeline run end to end:

```bash
npm run mock-server                        # terminal 1 — leave running
FRAUDX_ENDPOINT_URI=http://localhost:4001 FRAUDX_LOGIN_EMAIL=mock@example.com FRAUDX_LOGIN_PASSWORD=mock npm run eval   # terminal 2
```

## CI

`.github/workflows/eval-workflow.yml` ("Eval Workflow" in the Actions tab) is a
manual-dispatch-only GitHub Actions workflow (Actions tab → "Run workflow") — nothing runs
automatically on push or pull request, since the full eval hits a live paid endpoint.
Dispatching it prompts for a `mode`:

- **`tests-only`** (default) — runs `npm test` only. No secrets required.
- **`full-eval`** — runs `npm test` first (the `unit-tests` job), and only if that passes, runs
  the real `npm run eval` against `FRAUDX_ENDPOINT_URI` (the `full-eval` job, gated with
  `needs: unit-tests`) — so a broken build fails in seconds instead of burning 30-60+ minutes of
  real eval time. Generated PDF reports (`reports/**`) are uploaded as a workflow artifact, even
  if the eval run itself "fails" (an assertion not meeting its pass bar is a real finding, not a
  CI misconfiguration). Only one `full-eval` run can be in flight at a time
  (`concurrency: fraudx-full-eval`) — the real platform has shared, account-level ingestion
  limits, so overlapping real evals would contend with each other.

  `full-eval` requires these repo (or environment) secrets: `FRAUDX_ENDPOINT_URI`,
  `FRAUDX_LOGIN_EMAIL`, `FRAUDX_LOGIN_PASSWORD`, `GRADER_PROVIDER`, and whichever of
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` matches `GRADER_PROVIDER`'s value (both are passed
  through; an unused one is simply ignored).

  Dispatching `full-eval` also accepts three optional inputs — `newClaimName`,
  `ingestionModelName`, `processingModelName` — to test a different claim name and/or
  ingestion/processing model against the same golden claim's documents and answer key for that
  one run, without editing `testdata/claims.json`. `ingestionModelName`/`processingModelName`
  must be the exact `displayName` from the FraudX platform's model catalog (e.g.
  `openai-gpt-5.4`) — plain model names collide across providers, so `displayName` (which embeds
  the provider) is what's matched, exactly, not fuzzily. Leave all three blank to run the
  committed golden claim(s) unchanged.

## Known environment limitations

In some environments, the installed `promptfoo` + `drizzle-orm` + `better-sqlite3`
combination fails to persist ANY eval run to promptfoo's local results database:

```
SqliteError: FOREIGN KEY constraint failed
    at ... models/eval.js:141
```

This reproduces even with promptfoo's own stock `echo` provider and no custom
code — it is not caused by anything in this repo. Upgrading promptfoo
(`npm install promptfoo@latest`) already resolved this: this repo now pins
`^0.122.0`, and a real end-to-end run against that version no longer
reproduces the bug.

## Adding another golden claim

`testdata/claims.json` is an array — add another entry to it (following the
existing shape) and re-run `npm run generate:tests` (this also happens
automatically before `npm test`/`npm run eval`) to regenerate `tests.vars.yaml`
with one promptfoo test case per claim. Each claim is scored independently;
there's no cap on how many can run in the same suite. Keep in mind the FraudX
eval doc's own intent for this kind of fixture — *"a single, versioned,
immutable claim... keep it small, fixed, and fast — it is the safety net, not
a full test plan"* — so favor a handful of curated claims over a large,
slow-to-run set; a much bigger benchmark/regression run is still a different
thing than this per-change smoke test.
