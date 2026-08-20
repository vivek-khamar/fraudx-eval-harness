# fraudx-eval-harness

A standalone promptfoo eval that re-runs an existing, already-processed FraudX claim (named by
`SOURCE_BUCKET_ID`) through the document-ingestion + report pipeline against a freshly-created
bucket, and scores that new run as a regression check — validated against the existing bucket's
own report, not a hand-curated answer key.

## Design

- **The provider is blind to the answer key.** `src/provider.js` only ever reads
  `context.vars.bucket`. It never touches
  `context.vars.expected`. This is enforced by a unit test in `provider.test.js` —
  if the pipeline's retrieval context could ever see the expected answers, "accuracy"
  would be meaningless.
- **The eval triggers real work, nothing is simulated.** `src/provider.js` calls your
  actual ingestion and processing endpoints and times them with its own stopwatch.
  Each `npm run eval` run performs one full pipeline run — creating and processing a
  brand-new claim — against the bucket named by `SOURCE_BUCKET_ID`, not a mock. Each
  call is bounded by an `AbortSignal` timeout, configurable via
  `FRAUDX_HTTP_TIMEOUT_MS` (default 900000ms), so a hung endpoint can't block
  the eval forever.
- **Time never enters a promptfoo assertion.** Ingest time and processing time are
  just fields on the provider's output, already timed by the time promptfoo sees
  them. `scripts/score-dashboard.js` reports them as-is — no budget or percentage
  math, just the raw millisecond values.
- **Accuracy is graded inside promptfoo**, via three assertions applied to the run's one test
  case — built by `scripts/build-tests-vars.js` from the bucket named by `SOURCE_BUCKET_ID`:
  `qa_match`, `report_quality`, and `metadata_match`.
  - `qa_match` (`javascript`, `src/lib/qa-match-assertion.js`) computes up to three independent
    signals and reports them as named scores from a single assertion:
    - `riskStatusMatch` (deterministic): the fraction of that claim's predefined questions whose
      `riskStatus` exactly matches the expected `expectedRiskStatus` (the existing bucket's own
      report's `riskStatus` for that question).
    - `answerContentMatch` (LLM-graded): one rubric call PER QUESTION (not one batched call for
      all of a claim's questions) that judges that question's actual answer text against its
      expected `expectedAnswerSummary` (the existing bucket's own answer text for that question)
      for semantic (not exact-wording) match, and returns the fraction of questions that match.
    - `citationMatch` (LLM-graded, optional per question): for each question in the existing
      bucket's own report, `scripts/build-tests-vars.js` extracts that question's own cited
      `(documentId, chunkId)` pairs from its answer text and resolves each to its exact verbatim
      text via the existing bucket's own S3 chunk-grounding file (fetched directly by
      `src/s3-client.js`'s `fetchChunkGroundingData`, the same lookup `src/provider.js` uses for
      the freshly-created bucket — see below) — populating that question's `expectedChunkText`
      **array of strings** automatically, not by hand. A question's answer can draw on several
      distinct source chunks, so `expectedChunkText` can list more than one passage when that's
      the case; a question whose cited chunks don't resolve gets no `expectedChunkText` at all
      (capped at `MAX_EXPECTED_CHUNKS_PER_QUESTION` — 10 — entries, first-cited-first-kept, on
      the rare question with more distinct cited chunks than that). For every question that ends
      up with a non-empty array, `citationMatch` resolves that question's actually-cited
      `(documentId, chunkId)` pairs (from the freshly-processed bucket's own report) against
      `output.chunkGroundingData`, then pairs each **resolved citation from this run** with its
      most content-similar **expected passage from the baseline** (`src/lib/qa-match-assertion.js`'s
      `greedyPairBySimilarity`, called with this run's citations as the primary side — a cheap,
      deterministic, dependency-free word-overlap score computed locally, no LLM/network call) and
      asks the grader whether that one paired expected passage semantically supports that one
      resolved chunk's actual text — **one grader call per pair**, not a search across every
      expected passage and not a dependency on citation order between the two runs (a correct
      answer that cites the same material in a different order than the baseline run did still
      pairs correctly). Putting this run's citations on the primary side (rather than the
      baseline's) means the question being asked is **"does every citation this run actually made
      hold up against the baseline material,"** not "did this run recreate every citation the
      baseline made" — a run that cites *fewer* distinct chunks than the baseline isn't penalized
      for that alone, only for citing something that doesn't hold up. Pairing is one-to-one and
      greedy: every possible (resolved, expected) combination is scored, then claimed
      highest-similarity-first, so the same expected passage can never be claimed by two different
      resolved citations. `citationMatches` for the question is `true` only if **every** resolved
      citation's pairing matches — a single unmatched pairing fails the whole question, even if the
      others matched; `citationMatchReason` reports the unmatched pairings' own reasons when any
      fail, or all pairings' reasons joined with `" | "` when every pairing matches (and just that
      one pairing's own reason, unwrapped, for the common single-citation case). A resolved
      citation left with no unclaimed expected passage (this run cited more distinct chunks than
      the baseline did for this question, or every plausible candidate already claimed by a closer
      match) is an automatic non-match with no grader call spent on it; any expected passage left
      unclaimed after every resolved citation is paired is simply unused, with no penalty. A
      citation that doesn't resolve (missing grounding data, or that specific chunk absent from it)
      is skipped rather than counted as a mismatch by itself; if *no* citation resolves at all, the
      question fails with a fixed reason and no grader call is made. Neither `documentId` nor
      `chunkId` is ever compared directly — both are per-ingestion and change every run — only the
      chunk *text* they resolve to is compared. Questions with no `expectedChunkText` are excluded
      from this fraction. If *no* question in the existing bucket's report has one, `citationMatch`
      is `undefined` (not `0`). `citationMatch` is
      reported for visibility (in `namedScores` and the PDF) but is not part of the accuracy
      formula below. Each graded question also gets its own `citationMatchScore` — the percentage
      of *that question's* pairings that matched (not just the all-or-nothing `citationMatches`
      boolean), `0` when no citation resolved at all — which is what the PDF's per-question
      Citation Match column actually shows (see below).

    Questions are matched between the existing bucket's `expected.qa` and the freshly-processed
    bucket's real report by `question` text, not `predefinedQuestionId` — like `documentId`/
    `chunkId`, that id is minted fresh by the platform on every claim-processing run, so the same
    claim re-ingested twice gets two different sets of ids for the same questions.
    `predefinedQuestionId` is still carried through `perQuestionBreakdown` (sourced from the
    existing bucket's own report) for readability, not for matching.

    The assertion also returns a `perQuestionBreakdown` array — one entry per question with its
    `predefinedQuestionId`, `question`, `actualAnswer`, `riskStatus` (the real report's raw value,
    used only for sorting the PDF's question order), `riskStatusMatches` (boolean — whether that
    `riskStatus` equals the expected `expectedRiskStatus` for this specific question), `matches`
    (boolean), `reason` (the grader's per-question reasoning), `actualCitedFileNames` (deduplicated
    fileNames actually cited, for visibility), `citationMatches` (boolean, or `undefined` if that
    question wasn't graded for citations), and `citationMatchReason` (the citation grader's own
    reason, or a fixed string when no citation resolved at all) — which is what
    `scripts/generate-pdf-report.js` renders in the question-by-question section of the PDF.

    The assertion's own score is the average of `riskStatusMatch` and `answerContentMatch`, plus
    `citationMatch` as a third term whenever at least one question in the claim was graded for
    it; `pass` defaults to `score > 0` unless a `threshold` is set on the `qa_match` assert entry
    in `promptfooconfig.yaml`.
  - `report_quality` (`llm-rubric`) judges the report's summary against the existing bucket's own
    summary and `citedDocumentsText` (fetched by `src/provider.js`, never from the expected/
    answer-key data — see below) on completeness, clinical correctness, missing information, and
    groundedness (whether every claim in the summary is actually supported by the cited source
    text, with no hallucination) — a single 0–1 score covering all of that.
  - `metadata_match` (`javascript`, `src/lib/metadata-match-assertion.js`) checks the real report's
    claim-level metadata against `expected*` fields that `scripts/build-tests-vars.js` populates
    directly from the existing bucket's own report, and reports two named scores:
    - `fraudRiskScoreMatch`: 1 if the real report's `fraudRiskScore` is within ±0.1 of the existing
      bucket's own `expectedFraudRiskScore`, else 0.
    - `entityFieldsMatch`: the fraction of `claimantName`, `defendant`, and `insuranceFirm` that
      match their `expected*` counterpart exactly, case- and whitespace-insensitively.
  `scripts/score-dashboard.js` (via its exported `computeAccuracy(namedScores)`, also reused by
  `scripts/generate-pdf-report.js` so the two never drift apart) combines four named scores as an
  equal 4-way split — `riskStatusMatch` and `citationMatch` are deliberately excluded from this
  formula (reported separately, for visibility, but not folded into accuracy):
  `acc = round(25×answerContentMatch + 25×report_quality + 25×fraudRiskScoreMatch + 25×entityFieldsMatch)`.
  The grading provider is read directly from `GRADER_PROVIDER` in `.env` — there's no hardcoded
  default, so `GRADER_PROVIDER` must be set. That provider's own API key must also be set.
- **`src/provider.js` fetches the text behind every citation via a separate S3 chunk-grounding file**
  (not the whole source bucket, and never based on the existing bucket's own report) and attaches it as
  `output.citedDocumentsText`, capped at 15,000 characters per fileName (concatenating multiple
  cited chunks from the same file) — this is what `report_quality` checks the summary's claims
  against. If a citation's `(documentId, chunkId)` isn't found in the grounding file, or the
  grounding file itself is missing for that claim, it's skipped rather than failing the run.
- **The provider recreates the claim from scratch on every run.** `src/provider.js` logs in, downloads every document from the bucket named by `SOURCE_BUCKET_ID`, creates a brand-new claim/bucket, and re-uploads them there — this untimed setup step exists because the FraudX platform processes per-claim, and each eval run needs its own fresh claim to submit against.
- **`src/provider.js` times ingestion and report-generation as two independent phases, and the dashboard reports them independently too.** With `skipGxProcess: false`, each document's own GX ingestion completes individually during the upload loop (`fileMetrics.completedFiles` reaches 5/5 before claim-level processing is ever triggered), so `src/provider.js` times that whole per-document loop — start of the first document to end of the last — as `ingestion.timeMs`. Separately, it times `triggerClaimProcessing` (the trigger) to `waitForClaimProcessing` resolving (`bucketStatus` reaching `SUCCESS`, i.e. the report is ready) as `processing.timeMs`. `dashboard.ingestionTime` and `dashboard.processingTime` are just those two raw values converted from milliseconds to seconds, unchanged and uncombined otherwise.
- **Citations are parsed out of free-text answers, then grounded via a separate S3 file.** The real report embeds citations as inline `<InTextCitation fileName="..." documentId="..." chunkId="...">` tags inside each answer's text, not a structured field. `src/lib/extract-cited-file-names.js`'s `extractCitedCitationsFromText` is the one place that regex-extracts `fileName`, `documentId`, and `chunkId` from these tags. Neither `documentId` nor `chunkId` is stable across eval runs (both are assigned per-ingestion), so neither is ever compared directly — instead, `src/s3-client.js`'s `fetchChunkGroundingData(bucketId)` reads a separate per-claim JSON file FraudX writes to an S3 bucket (keyed `{bucketId}.json`), which maps each citation's `(documentId, chunkId)` pair to the exact verbatim chunk text GX grounded that citation in. The bucket name itself is not hardcoded — it comes from `AWS_S3_BUCKET_NAME`, since different environments read from different buckets. `src/provider.js` uses this to build `citedDocumentsText` and exposes the raw lookup as `output.chunkGroundingData` so `src/lib/qa-match-assertion.js`'s `citationMatch` (per question) can reuse it without a second S3 fetch. Reading this bucket requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_S3_BUCKET_NAME` in `.env` (see `.env.example`).
- **`npm run score` (and therefore `npm run eval`) also writes a PDF report per scoreable claim.**
  `scripts/generate-pdf-report.js` reads the same `results.json` as the console dashboard and
  writes one PDF per claim that has a `bucketId` and passes its own renderability check, to
  `reports/<bucketId>/report-<timestamp>.pdf`, where `<timestamp>` is IST (Asia/Kolkata, not
  UTC and not the host machine's own timezone) at the moment that PDF-generation run actually
  happened (not the eval's own `results.timestamp`) — so re-running against the same
  `results.json` adds a new, distinctly timestamped file alongside any earlier ones instead of
  overwriting them. On the rare case of two runs landing in the same second, a numeric suffix
  (`-2`, `-3`, ...) is appended as a fallback.

  The PDF opens with a centered "Claim Eval Report" title and just the identity/provenance
  fields that belong to neither section below (bucket ID and "Generated at" — the same IST
  timestamp used in the filename, shown with no timezone label), then two explicitly headed
  sections:

  - **Document Ingestion** — a compact stat-card row (docs submitted, docs complete, docs
    failed, ingestion time), using only counts the pipeline actually has (no GPU/pod/quota/
    concurrency telemetry). A "Failed documents:" list (one `fileName: error` line per entry)
    follows only when `output.failedDocuments` is non-empty — a clean run's report grows no
    section for something that didn't happen.
  - **Claim Processing** — its own stat-card row (accuracy, processing time, risk status match
    %, answer content match %, plus a 5th citation-match % card only when
    `namedScores.citationMatch` is defined), then the question-by-question breakdown, the
    claim-metadata match table, and the overall summary.

  Within Claim Processing, questions are numbered sequentially (Q1, Q2, ...) and ordered by risk
  status (Detected, then Unsure, then Not Detected) rather than by their original ID, so the
  highest-risk findings read first. A table header (`Risk Status | Score | Risk Match | Citation
  Match`) precedes the per-question blocks; each question's heading is followed by a single
  bordered, colored row of those four short values (the question's actual risk status —
  distinct from whether it matched — the new 0-100 grader score, whether risk status matched,
  and `citationMatchScore` as a `formatScore`-rendered percentage — the fraction of this
  question's citation pairings that matched, `N/A` when the question wasn't graded for citations).
  The grader's own descriptive `citationMatchReason` text is computed and stored in
  `results.json`'s `perQuestionBreakdown` exactly as before — it's just no longer printed in the
  PDF, since it could run to several paragraphs per question; read it directly from
  `results.json` for the full explanation behind any citation-match percentage. Then the Answer
  and Reason render as full-width flowing
  paragraphs below the row so a single question's content stays together in reading order even
  across a page break. The "RISK ...:" prefix the real report embeds at the start of each answer
  is left in place. Raw `<InTextCitation>` tags in the Answer are replaced with small numbered
  `[n]` markers (`src/lib/extract-cited-file-names.js`'s `formatAnswerWithCitations`, a display
  copy only — the stored `actualAnswer` in `results.json` keeps its raw tags, since
  `citationMatch` grading reads citations off the raw text), with a gray "Sources: [n] fileName
  ..." legend line beneath the answer when it cites anything, entirely absent when it doesn't.
  Each filename in that legend is a real clickable PDF link to the citation's own `url` (the real
  report's `<InTextCitation>` tags carry one) when the tag has one, and plain unlinked text when
  it doesn't.

  After the question-by-question breakdown comes the claim-metadata match table
  (`fraudRiskScore` and the three entity fields, expected vs. actual — field names are
  humanized for display, e.g. `fraudRiskScore` reads as "Fraud Risk Score") and an overall
  summary. A claim that gets skipped (no `bucketId`, or missing the data the PDF needs, including
  ingestion's `docsSubmitted`/`docsComplete` counts) is logged via `console.error` with its
  `bucketId` and a reason, and `main()` prints a final `Wrote N report(s).` summary line, so a
  run that produces zero PDFs is never silent.

## Setup

```bash
npm install
cp .env.example .env   # fill in FRAUDX_ENDPOINT_URI, ANTHROPIC_API_KEY, SOURCE_BUCKET_ID,
                        # CLAIM_NAME/INGESTION_MODEL_NAME/PROCESSING_MODEL_NAME, and
                        # AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION/AWS_S3_BUCKET_NAME
                        # (needed to read the S3 chunk-grounding file — see .env.example)
```

## Running against the real FraudX platform

```bash
npm run eval
```

### Running it from Claude Code

`.claude/commands/run-eval.md` defines a `/run-eval` slash command that wraps the same
`npm run eval` invocation for use inside a Claude Code session, so you can trigger a real run by
just asking, e.g.:

```
/run-eval bucketId=31662 claimName=my-test-run ingestionModel=openai-gpt-5.1 processingModel=deepinfra-google/gemma-3-12b-it
```

Plain language works too (`/run-eval bucket 31662 claim name my-test-run`). `bucketId` is
required; if `claimName` is omitted, Claude proposes one (the real platform won't let you reuse a
name) and confirms it with you first. `ingestionModel`/`processingModel` fall back to
`INGESTION_MODEL_NAME`/`PROCESSING_MODEL_NAME` in `.env` when omitted. Every other env var
(`FRAUDX_ENDPOINT_URI`, `GRADER_PROVIDER`, AWS credentials, etc.) always comes from `.env` —
the command never prompts for or overrides those. Since a real run commonly takes 30–90+
minutes, Claude states back exactly what it's about to run before starting, then runs it in the
background and reports the pass/fail summary and the generated PDF's path once it finishes.

- Before anything else, `npm run eval`'s `preeval` hook runs `scripts/build-tests-vars.js`,
  which fails fast with a clear error if `FRAUDX_ENDPOINT_URI`, `SOURCE_BUCKET_ID`, or
  `CLAIM_NAME` is unset, or if the bucket named by `SOURCE_BUCKET_ID` has no completed report
  (or a report with no questions) to serve as ground truth. It then logs in, fetches that
  existing bucket's own report and its own S3 chunk-grounding file, resolves
  `INGESTION_MODEL_NAME`/`PROCESSING_MODEL_NAME` to platform model ids (via
  `POST /fraudx/api/v1/models/search`), and writes the result — the new claim's `bucketName`
  set to `CLAIM_NAME` — as a single generated test case into `tests.vars.yaml`. There's no
  single upfront check that names every missing env var at once the way the old
  claims.json-based setup did: each of `FRAUDX_ENDPOINT_URI`/`SOURCE_BUCKET_ID`/`CLAIM_NAME`
  is checked in sequence (first blank one wins), and an unset `INGESTION_MODEL_NAME`/
  `PROCESSING_MODEL_NAME` still fails later during this same `preeval` step (no model has a
  blank `displayName`, so the lookup throws before any real work starts). AWS credentials (`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY`/`AWS_REGION`) aren't explicitly validated either; only
  `AWS_S3_BUCKET_NAME` gets a dedicated check, in `src/s3-client.js`. Note that this
  `preeval` step's own S3 chunk-grounding fetch (for the *existing* bucket) is gated by
  `SKIP_S3_GROUNDING`, exactly like `src/provider.js`'s separate S3 lookup for the
  *freshly-created* bucket (see below and the mock-server walkthrough) — setting it skips
  both fetches.
- `npm run eval` runs `npm run eval:raw` (which runs `promptfoo eval` against
  `FRAUDX_ENDPOINT_URI`, grades the result, and writes `results.json`) and then
  `npm run score`. `--no-cache` is required — promptfoo caches provider responses
  by default, and a cached "response" would mean `src/provider.js` never actually
  calls your endpoint on a re-run, silently returning stale timing data that would
  make a real regression invisible. `--max-concurrency 1` ensures test cases run
  one at a time, not in parallel (currently there's just the one, per
  `SOURCE_BUCKET_ID`) — the real platform has shared, account-level ingestion
  limits (e.g. a cap on concurrently-ingesting files), so running claims
  concurrently risks them contending with each other for that same quota.
- `npm run score` reads `results.json` and prints one dashboard object per test case — a JSON
  array of `{ bucketId, ingestionTime, processingTime, accuracy }` entries, always exactly one
  entry under this bucket-driven design, for the single `SOURCE_BUCKET_ID` being validated. This
  console output is a quick sanity check, not the deliverable — the generated PDF (below) is
  what you actually read.

`bucketId` identifies the real, newly-created FraudX bucket this run produced (read from
`output.report.bucketId`, i.e. only available once the report was actually fetched) — not the
bucket named by `SOURCE_BUCKET_ID`, which is the existing bucket being validated against, not
the one this run creates. If the provider call failed before a report was ever fetched (e.g.
claim creation itself failed), that entry has no `bucketId` at all; the `error` text is the only
record of what happened.

If a claim's provider call errored (e.g. a platform outage, a bad model ID for the current
environment) or its accuracy score came out `NaN`, that claim's entry has an `error` field
instead of the three numbers — it does not stop any other entries in the same `results.json`
from being scored. A claim can still be fully scored even if `results.json` marks it as errored overall —
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
SOURCE_BUCKET_ID=31804 \
  FRAUDX_ENDPOINT_URI=http://localhost:4001 FRAUDX_LOGIN_EMAIL=mock@example.com FRAUDX_LOGIN_PASSWORD=mock \
  CLAIM_NAME=mock-claim INGESTION_MODEL_NAME=mock-ingestion-model PROCESSING_MODEL_NAME=mock-processing-model \
  SKIP_S3_GROUNDING=true \
  npm run eval   # terminal 2
```

`SOURCE_BUCKET_ID=31804` matches `test/mock-server.js`'s own default — that's the bucket id its
`/fraudx/api/v1/gx-bucket/list-buckets` handler recognizes as the "existing" bucket and serves an
already-completed report for, which is what `scripts/build-tests-vars.js` fetches as ground truth.

`SKIP_S3_GROUNDING=true` covers both the *freshly-created* bucket's side and the *existing*
bucket's side of this flow: the mock server hands the new claim a fake `bucketId` (`99999`) with
no real S3 chunk-grounding file behind it, and `SKIP_S3_GROUNDING=true` tells both `src/provider.js`
and `scripts/build-tests-vars.js` to skip their S3 lookups entirely. For the freshly-created bucket,
`src/provider.js` skips its own S3 lookup (`chunkGroundingData` is `null`, `citedDocumentsText` is
`{}`, and `citationMatch` reports "no citation resolved" for every question). For the existing
bucket, `scripts/build-tests-vars.js` skips its S3 fetch during the `preeval` step, so this entire
mock-server flow is entirely infra-free — zero AWS credentials needed. A bucket with no matching
grounding file resolves gracefully to `null` (no `expectedChunkText` on any question), which is
fine for a local dry run. Never set `SKIP_S3_GROUNDING=true` in CI or against the real platform —
it silently empties the grounding-based signals for both the existing and freshly-created buckets.

## CI

`.github/workflows/eval-workflow.yml` ("Eval Workflow" in the Actions tab) is a
manual-dispatch-only GitHub Actions workflow (Actions tab → "Run workflow") — nothing runs
automatically on push or pull request, since the full eval hits a live paid endpoint.
Dispatching it prompts for a `mode`:

- **`tests-only`** — runs `npm test` only. No secrets required.
- **`full-eval`** (default) — runs `npm test` first (the `unit-tests` job), and only if that passes, runs
  the real `npm run eval` against `FRAUDX_ENDPOINT_URI` (the `full-eval` job, gated with
  `needs: unit-tests`) — so a broken build fails in seconds instead of burning 30-60+ minutes of
  real eval time. Generated PDF reports (`reports/**`) are uploaded as a workflow artifact named
  `reports` (`actions/upload-artifact@v4`), even if the eval run itself "fails" (an assertion not
  meeting its pass bar is a real finding, not a CI misconfiguration) — the runner itself is
  ephemeral, so the PDF only survives past the job by being uploaded this way. Download it from
  the completed run's page on GitHub, under **Artifacts** at the bottom — not from any path on
  disk. GitHub's default retention applies (90 days unless the repo overrides it); this workflow
  doesn't set a custom `retention-days`. Only one `full-eval` run can be in flight at a time
  (`concurrency: fraudx-full-eval`) — the real platform has shared, account-level ingestion
  limits, so overlapping real evals would contend with each other.

  `full-eval` requires these repo (or environment) secrets: `FRAUDX_ENDPOINT_URI`,
  `FRAUDX_LOGIN_EMAIL`, `FRAUDX_LOGIN_PASSWORD`, `GRADER_PROVIDER`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET_NAME` (for reading the S3
  chunk-grounding file), and whichever
  of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` matches `GRADER_PROVIDER`'s value (both are passed
  through; an unused one is simply ignored).

  Dispatching `full-eval` also takes four workflow inputs — `sourceBucketId`, `newClaimName`,
  `ingestionModelName`, `processingModelName` — which feed `SOURCE_BUCKET_ID`/`CLAIM_NAME`/
  `INGESTION_MODEL_NAME`/`PROCESSING_MODEL_NAME`. Only `sourceBucketId` is marked `required` in
  the workflow schema itself, so it can't be dispatched blank; the other three default to an
  empty string in the schema, but `npm run eval`'s `preeval` hook (`scripts/build-tests-vars.js`)
  still fails fast on a blank `ingestionModelName`/`processingModelName` (no model has a blank
  `displayName`, so resolving it throws before any real work starts) — a blank `newClaimName`
  isn't caught locally at all, though, and only surfaces once the pipeline calls the FraudX API
  to create a claim with it. `ingestionModelName`/`processingModelName` must be the exact
  `displayName` from the FraudX platform's model catalog (e.g. `openai-gpt-5.4`) — plain model
  names collide across providers, so `displayName` (which embeds the provider) is what's
  matched, exactly, not fuzzily.

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

## Choosing which bucket to validate against

There's no claims file to hand-edit anymore. `SOURCE_BUCKET_ID` alone selects what a run
validates against — point it at a different existing, already-processed bucket (in `.env`
locally, or via the `sourceBucketId` workflow-dispatch input in CI) and `scripts/build-tests-vars.js`
fetches that bucket's own report and S3 chunk-grounding file fresh, live, on the next
`npm run generate:tests`/`npm run eval` (there's nothing else to regenerate or keep in sync).
Each run validates exactly one bucket this way — `tests.vars.yaml` always ends up with a single
generated test case, not an array to add more entries to. Keep in mind the FraudX eval doc's own
intent for this kind of check — *"a single, versioned, immutable claim... keep it small, fixed,
and fast — it is the safety net, not a full test plan"* — the safety net here is "does the
freshly-processed bucket still match what the existing bucket's own report already says", not a
hand-curated answer key; a much bigger benchmark/regression run across many buckets is still a
different thing than this per-change smoke test.
