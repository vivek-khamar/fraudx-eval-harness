# fraudx-claim-eval

A standalone promptfoo eval that runs one immutable "golden claim" through the FraudX
document-ingestion + report pipeline and scores it against a human-verified answer key.

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
  them. `scripts/score-dashboard.js` applies the budget formula
  `100 × min(1, budget ÷ measured)` to them after the run finishes.
- **Accuracy is graded inside promptfoo**, via two assertions on the one test case:
  - `llm-rubric` (metric `qa_summary_accuracy`) grades whether the report's summary
    and answers convey the same meaning as the gold answer key, with no hallucination.
  - `javascript` (metric `citation_accuracy`) deterministically checks that every
    answer's citation matches the gold citation's `fileName`.
  `scripts/score-dashboard.js` blends them `0.6 × rubric + 0.4 × citation`.
  The `llm-rubric` grading provider is read directly from `GRADER_PROVIDER` in `.env`
  (e.g. `anthropic:messages:claude-sonnet-4-5` or `openai:chat:gpt-4o`) via
  `defaultTest.options.provider` in `promptfooconfig.yaml` — there's no hardcoded
  default, so `GRADER_PROVIDER` must be set. That provider's own API key must also
  be set (e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).
- **The provider recreates the claim from scratch on every run.** `provider.js` logs in, downloads every document from the golden claim's frozen source bucket, creates a brand-new claim/bucket, and re-uploads them there — this untimed setup step exists because the FraudX platform processes per-claim, and each eval run needs its own fresh claim to submit against.
- **`ingestTime` and `claimProcTime` are measured as two independent phases.** With `skipGxProcess: false`, each document's own GX ingestion completes individually during the upload loop (`fileMetrics.completedFiles` reaches 5/5 before claim-level processing is ever triggered), so `provider.js` times that whole per-document loop as `ingestion.timeMs`, and separately times `triggerClaimProcessing` + `waitForClaimProcessing` (the report/Q&A generation phase) as `processing.timeMs`.
- **Citations are parsed out of free-text answers.** The real report embeds citations as inline `<InTextCitation fileName="...">` tags inside each answer's text, not a structured field — `citation_accuracy` regex-extracts them and matches on `fileName`.
- **Entity extraction accuracy (`entAcc`) is not implemented yet** — it stays `null`
  in the dashboard output until that scoring is built.

## Setup

```bash
npm install
cp .env.example .env   # fill in FRAUDX_TEST_ENDPOINT and ANTHROPIC_API_KEY
```

## Running against the real FraudX platform

```bash
npm run eval:full
```

- `npm run eval` runs `promptfoo eval` against `FRAUDX_TEST_ENDPOINT`, grades the
  result, and writes `results.json`. `--no-cache` is required — promptfoo caches
  provider responses by default, and a cached "response" would mean `provider.js`
  never actually calls your endpoint on a re-run, silently returning stale timing
  data that would make a real regression invisible.
- `npm run score` reads `results.json` and prints the four dashboard numbers:

```json
{
  "ingestTime": 100,
  "claimProcTime": 92,
  "acc": 94,
  "entAcc": null
}
```

## Running the unit tests

```bash
npm test
```

## Trying it locally without hitting real infra

A mock server stands in for the FraudX ingest/process endpoints so you can see the
whole pipeline run end to end:

```bash
npm run mock-server                        # terminal 1 — leave running
FRAUDX_TEST_ENDPOINT=http://localhost:4001 FRAUDX_LOGIN_EMAIL=mock@example.com FRAUDX_LOGIN_PASSWORD=mock npm run eval:full   # terminal 2
```

## CI

Wrap the same two commands (`npm run eval`, `npm run score`) in a CI workflow step —
nothing about the repo changes between local and CI execution.

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

## Scaling to multiple claims

This repo is deliberately built around **one** golden claim, per the FraudX
eval doc's own intent: *"a single, versioned, immutable claim... keep it small,
fixed, and fast — it is the safety net, not a full test plan."* Running every
change against a bigger claim set is a legitimate thing to want, but it's a
**different suite** — a broader regression/benchmark run, not the per-change
smoke test this repo is. If you need that, build a separate
`promptfooconfig-regression.yaml` with a `tests:` list of multiple claim fixture
files, and run it on a slower cadence (nightly, or before a model swap) rather
than wiring it into the same gate that blocks merges today.
