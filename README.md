# fraudx-claim-eval

A standalone promptfoo eval that runs one or more immutable "golden claims" through the FraudX
document-ingestion + report pipeline and scores each against a human-verified answer key.

## Design

- **The provider is blind to the answer key.** `provider.js` only ever reads
  `context.vars.claimId` and `context.vars.bucket`. It never touches
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
- **Accuracy is graded inside promptfoo**, via one assertion (`qa_match`) producing two named
  sub-scores, plus a separate `report_quality` assertion, applied to every test case (one per
  golden claim):
  - `qa_match` (`javascript`, `scripts/qa-match-assertion.js`) computes two independent signals
    and reports both as named scores from a single assertion:
    - `riskStatusMatch` (deterministic): the fraction of that claim's predefined questions whose
      `riskStatus` exactly matches the gold `expectedRiskStatus`.
    - `answerContentMatch` (LLM-graded): one rubric call per claim — not per question — that
      judges every question's actual answer text against its gold `expectedAnswerSummary` for
      semantic (not exact-wording) match, and returns the fraction that match.
    The assertion's own score is the average of the two; `pass` defaults to `score > 0` unless
    a `threshold` is set on the `qa_match` assert entry in `promptfooconfig.yaml`.
  - `report_quality` (`llm-rubric`) judges the report's summary against the gold summary and
    `citedDocumentsText` (fetched by `provider.js`, never from the answer key — see below) on
    completeness, clinical correctness, missing information, and groundedness (whether every claim
    in the summary is actually supported by the cited source text, with no hallucination) — a
    single 0–1 score covering all of that.
  `scripts/score-dashboard.js` combines all three as equal thirds:
  `acc = round((100/3)×riskStatusMatch + (100/3)×answerContentMatch + (100/3)×report_quality)`.
  `acc` numbers from before this scoring change are not directly comparable to `acc` numbers
  after it — the weighting and underlying signals both changed.
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
- **Entity extraction accuracy is not implemented yet** — the dashboard has no field for it
  until that scoring is built.

## Setup

```bash
npm install
cp .env.example .env   # fill in FRAUDX_TEST_ENDPOINT and ANTHROPIC_API_KEY
```

## Running against the real FraudX platform

```bash
npm run eval
```

- `npm run eval` runs `npm run eval:raw` (which runs `promptfoo eval` against
  `FRAUDX_TEST_ENDPOINT`, grades the result, and writes `results.json`) and then
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

## Running the unit tests

```bash
npm test
```

## Trying it locally without hitting real infra

A mock server stands in for the FraudX ingest/process endpoints so you can see the
whole pipeline run end to end:

```bash
npm run mock-server                        # terminal 1 — leave running
FRAUDX_TEST_ENDPOINT=http://localhost:4001 FRAUDX_LOGIN_EMAIL=mock@example.com FRAUDX_LOGIN_PASSWORD=mock npm run eval   # terminal 2
```

## CI

Wrap `npm run eval` in a CI workflow step — nothing about the repo changes
between local and CI execution.

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
