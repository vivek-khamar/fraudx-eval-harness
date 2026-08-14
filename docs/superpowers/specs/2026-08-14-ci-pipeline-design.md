# CI Pipeline Design

## Goal

Give this repo a GitHub Actions workflow that can run the unit test suite and, separately, the full real-FraudX eval + PDF report flow, without either one running automatically on every push or PR.

## Background

This repo currently has no CI configuration at all (`.github/workflows/` doesn't exist) and no git remote configured. The README's existing "## CI" section only says to "wrap `npm run eval` in a CI workflow step" — it was aspirational, not implemented.

Two very different kinds of work exist in this repo, and they must be triggered differently:

- **`npm test`** — 116 unit tests (`provider.test.js`, `config-shape.test.js`, `scripts/score-dashboard.test.js`, `scripts/qa-match-assertion.test.js`, `scripts/metadata-match-assertion.test.js`, `scripts/generate-pdf-report.test.js`, `fraudx-client.test.js`, `scripts/generate-tests-vars.test.js`). All mocked — no live network calls, no credentials, runs in about a second.
- **`npm run eval`** — logs into the real FraudX gateway, ingests a golden claim's documents, waits for real processing, grades the result with a real LLM grader, and (via `npm run score`, chained on) writes the console dashboard and PDF reports. This hits a live paid endpoint with real credentials, and the ingestion/processing poll timeouts default to 60 minutes each (`FRAUDX_UPLOAD_POLL_TIMEOUT_MS`, `FRAUDX_PROCESSING_POLL_TIMEOUT_MS`), so a single claim can realistically take well over an hour.

Given that gap, the pipeline must never trigger the real eval automatically — it needs to be an explicit, deliberate action.

## Decisions

- **Platform:** GitHub Actions. One new file: `.github/workflows/ci.yml`.
- **Trigger:** `workflow_dispatch` only, with a required `mode` input (`choice`, options `tests-only` / `full-eval`, default `tests-only`). Nothing runs on `push` or `pull_request`.
- **Jobs:**
  - `unit-tests` — always runs regardless of `mode`. Checks out the repo, sets up Node 22.x (satisfies `engines: ">=20.16.0 <21 || >=22.3.0"`) with npm's dependency cache (`actions/setup-node`'s `cache: 'npm'`, keyed off the existing `package-lock.json`), runs `npm ci`, then `npm test`. No secrets required.
  - `full-eval` — only runs when `mode == 'full-eval'` (`if: inputs.mode == 'full-eval'`), and only after `unit-tests` succeeds (`needs: unit-tests`). This is a deliberate gate: `full-eval` costs real time (30-60+ minutes) and money (real API/grader calls) — if the code is broken, `unit-tests` fails in seconds and `full-eval` never starts. Runs `npm run eval` (which internally chains `eval:raw` — the real promptfoo run against `FRAUDX_TEST_ENDPOINT` — and `score`, which writes the console dashboard and generates PDF reports into `reports/`), reading required config from GitHub Actions secrets (below). Sets `timeout-minutes: 240` as an explicit safety net (GitHub's default job timeout is 360 minutes; 240 gives generous headroom for the current single golden claim while still failing a truly hung run well before the platform default).
- **Concurrency:** a `concurrency` block scoped to the `full-eval` job only (not `unit-tests`, which should stay free to run anytime) — group name `fraudx-full-eval`, `cancel-in-progress: false` (queue a second dispatch rather than cancel an in-flight real claim). This mirrors the reasoning the README already documents for local `--max-concurrency 1`: the real FraudX platform has shared, account-level ingestion limits, so two real evals should never run concurrently.
- **Artifact upload:** `full-eval` uploads `reports/**` (the generated PDFs only, not `results.json`) via `actions/upload-artifact`, with `if: always()` on that step — so PDFs are still available for inspection even when the eval step itself exits nonzero (which happens whenever an assertion doesn't meet its pass bar; that's a meaningful signal about the FraudX pipeline's quality, not a CI misconfiguration, and shouldn't suppress the artifact).
- **Secrets:** `full-eval` needs the following, added to the GitHub repo (or a GitHub Environment) as Actions secrets — this workflow only ever reads them via `${{ secrets.NAME }}`; it never writes or logs them, and no secret values are handled in this design/implementation process itself:
  - `FRAUDX_TEST_ENDPOINT`
  - `FRAUDX_LOGIN_EMAIL`
  - `FRAUDX_LOGIN_PASSWORD`
  - `GRADER_PROVIDER`
  - `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` — both are passed through as env vars (from whichever secrets exist; an unset secret becomes an empty string, which is harmless) since `GRADER_PROVIDER`'s value determines which one promptfoo actually needs at runtime, and this workflow has no way to know that value ahead of time.

  These are passed as job-level `env:` vars (not a generated `.env` file) — `dotenv` (used by `provider.js` and `scripts/generate-pdf-report.js`) does not override already-set `process.env` values, so real CI-injected env vars take effect exactly as a local `.env` file would.
- **Scope explicitly excluded** (per your choices): no automatic `push`/`pull_request` triggers; `tests-only` mode runs `npm test` only (no mock-server end-to-end smoke run); no `results.json` upload, only the `reports/` PDFs.

## Ad-hoc claim overrides on `full-eval`

`full-eval` gains three additional **optional** `workflow_dispatch` string inputs — `newClaimName`, `ingestionModelName`, `processingModelName` — all defaulting to empty. Leaving them blank runs the golden claim(s) from the committed `testdata/claims.json` completely unchanged, exactly as described above. Filling one or more in lets a dispatcher test a *different* claim name and/or ingestion/processing model against the *same* underlying golden-claim documents and answer key for that run only, without editing or committing `testdata/claims.json` — useful for evaluating a model swap on demand.

**Why this is safe to bolt onto the existing golden claim, not a separate mechanism:** `sourceBucketId` (which source documents to re-ingest) and the answer key (`expectedFraudRiskScore`, `expectedClaimantName`, `expectedDefendant`, `expectedInsuranceFirm`, `summary`, `questions`) all describe the frozen source documents themselves, which don't change just because a different ingestion/processing model is used to process them. Only `newClaimName`, `ingestionModelId`, and `processingModelId` are actually about *how* the claim is created and processed — those are the only three fields this override touches. With today's single golden claim, the override applies to that one entry; if more golden claims exist later, it applies to all of them, since there's no per-claim targeting input.

### Resolving a model name to an ID

The FraudX platform has no stable numeric ID a human would type from memory — `ingestionModelId`/`processingModelId` are opaque platform-assigned integers. The platform's `POST {FRAUDX_TEST_ENDPOINT}/fraudx/api/v1/models/search` endpoint (same `Authorization: Bearer`, `x-org-id`, `x-user-id` auth pattern `fraudx-client.js` already uses everywhere else, sourced from the existing `login()`'s `{ token, orgId, userId }`) returns the full model catalog, filterable by `criteria: [{ column: 'types.name', operator: 'EQUALS', values: ['INGESTION'] }]` (or `'PROCESSING'`). Each entry has a `name` (e.g. `"gpt-5.4"`) that is **not unique** — the same model name appears under many different providers (e.g. `moonshotai/kimi-k2.6` appears under DeepInfra, Cloudflare, Parasail, and others, each a distinct `id`). Each entry's `displayName` (e.g. `"openai-gpt-5.4"`, `"deepinfra-google/gemma-3-27b-it"`) embeds the provider/tag and is unique per entry — so `ingestionModelName`/`processingModelName` inputs must be given as the exact `displayName` string, matched exactly (not fuzzy, not case-insensitive — consistent with this project's existing preference for exact matching over fuzzy matching, see `metadata-match-assertion.js`'s entity-field comparison). A `displayName` with no match (for the required type) is a hard error with a clear message; no silent fallback to a wrong model.

### New code

- **`fraudx-client.js`**: new exported function `searchModels(base, auth, typeName, timeoutMs)` — POSTs to `/fraudx/api/v1/models/search` with `{ page: 0, size: 10000, criteriaOperator: 'AND', criteria: [{ column: 'types.name', operator: 'EQUALS', values: [typeName] }] }`, using the same fetch/AbortSignal-timeout/error-handling conventions as every other function in this file, and returns `response.response.content` (the array of model entries).
- **`scripts/resolve-model-id.js`** (new): exports `resolveModelId(base, auth, displayName, typeName, timeoutMs)`, which calls `searchModels`, finds the entry whose `displayName` exactly equals the given string, and returns its `id` — throwing a clear error (naming the `displayName` and `typeName` searched for) if nothing matches.
- **`scripts/apply-adhoc-claim-overrides.js`** (new, CLI entry point): reads three optional env vars (`ADHOC_NEW_CLAIM_NAME`, `ADHOC_INGESTION_MODEL_NAME`, `ADHOC_PROCESSING_MODEL_NAME` — GitHub Actions inputs are passed to steps as env vars, not argv). For each non-empty value, applies the override to every entry in `testdata/claims.json` (`newClaimName` directly; `ingestionModelName`/`processingModelName` via `login()` + `resolveModelId(..., 'INGESTION'|'PROCESSING', ...)`), then overwrites `testdata/claims.json` **in the CI runner's working copy only** — this file is never committed, and the workflow's checkout is thrown away after the job ends, so there is no risk of an ad-hoc override leaking into the repo. Logs what changed (claim name, resolved model IDs) to stdout so it's visible in the Action's log. Does nothing (no login, no API calls) if all three inputs are empty.

### Workflow change

A new step in the `full-eval` job, after `npm ci` and before `npm run eval`: `if: inputs.newClaimName != '' || inputs.ingestionModelName != '' || inputs.processingModelName != ''`, running `node scripts/apply-adhoc-claim-overrides.js` with the three inputs passed through as env vars. `npm run eval`'s existing `preeval` hook (`generate:tests`) then picks up the locally-overridden `testdata/claims.json` automatically — no change needed to `npm run eval` itself.

### Testing

- `scripts/resolve-model-id.test.js`: mocks `fraudx-client.js`'s `searchModels` (non-destructured `require`, matching this repo's established mocking convention) with a fixture containing several entries that share the same `name` but have distinct `displayName`s; asserts exact-`displayName` matching picks the right `id`, and that a non-matching `displayName` throws a clear error naming what was searched for.
- `scripts/apply-adhoc-claim-overrides.test.js`: mocks `login()` and `resolveModelId()`; verifies (a) no-op — no login/API calls, `testdata/claims.json` untouched — when all three env vars are empty, (b) a `newClaimName`-only override leaves model IDs untouched, (c) an `ingestionModelName` override resolves via the mocked lookup and writes only `ingestionModelId`, (d) the same for `processingModelName`/`processingModelId`, (e) the rewritten `testdata/claims.json` is valid JSON matching the expected shape.

## Testing

There's no meaningful way to unit-test a GitHub Actions YAML file. Verification is:
1. Validate the YAML parses and the job graph (`needs`, `if` conditions) is structurally correct using `actionlint` if available, or a manual review against GitHub's workflow syntax.
2. Push the workflow file and manually dispatch it once in `tests-only` mode (no secrets required) to confirm `unit-tests` runs and passes.
3. Document, but do not require, a manual `full-eval` dispatch as part of this work — that needs real secrets configured in the GitHub repo first, which is your action to take separately.

## Documentation

Update the README's existing "## CI" section to describe the actual workflow (trigger, modes, gate, secrets, artifacts) instead of the current aspirational one-liner.
