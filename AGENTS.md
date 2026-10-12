# AGENTS.md

This file is the single-file agent harness for AutoTriage. It is intentionally
short enough to stay useful in context while still giving agents the map,
constraints, and feedback loops needed to make reliable changes.

The design follows OpenAI's harness engineering guidance: agent effectiveness
comes from repository-local knowledge, legible systems, enforceable invariants,
and tight validation loops rather than a large instruction manual. Keep this
file as the table of contents and operating contract for now; promote repeated
rules into scripts, tests, or CI when they become stable.

Source: https://openai.com/index/harness-engineering/

## Project Contract

AutoTriage is a GitHub Action for AI-assisted issue and pull request triage. It
uses repository context, issue or pull request history, and a configurable prompt
to plan and apply authorized GitHub operations.

Preserve these invariants:

- Runtime compatibility: Node.js 24 or newer.
- Action entry point: `dist/index.js`.
- Source of truth: TypeScript under `src/`.
- Generated bundle: `dist/` is committed, but never edited manually.
- Default runtime prompt: with no `.github/AutoTriage.prompt` at the run's
  commit, the built-in label-only prompt (`src/prompt.ts`) is used. The
  `examples/AutoTriage.prompt` file is a copy-paste starting point, not bundled.
  The built-in prompt gives every item exactly one kind label whoever opened it, and recognizes kind labels by their descriptions, so it doesn't depend on any repository's label names.
- Policy source: the policy and README are read through the GitHub API at `GITHUB_SHA` (the default branch on a local run), never from the workspace, so consumer workflows need no checkout.
  A transient failure reading them stops the run with a warning instead of falling back to the built-in prompt.
- Unit tests must not require real GitHub or model API credentials, or any network
  beyond localhost.
- Public action behavior must stay aligned across `action.yml`, `README.md`,
  tests, and generated `dist/`.
- A run fails the job only for a configuration error or a bug in AutoTriage.
  Model failures, deferred items and GitHub's own failures, such as outages and
  rate limits, only warn through annotations and the job summary.

## Context Map

Start with the smallest useful context:

- `src/index.ts` - action entry point.
- `src/config.ts` and `src/env.ts` - action inputs and environment handling.
  `REMOVED_INPUTS` in `env.ts` lists every input AutoTriage no longer takes, with a migration hint, and passing one fails the run as a configuration error.
- `src/runner.ts` and `src/issueProcessor.ts` - orchestration and per-item work.
  A sweep takes at most `MAX_SWEEP_ITEMS` (30, in `autoDiscover.ts`) from its queue, and revisits unchanged and recently closed items only when the repository has a policy file. An explicit `issues` list runs in full.
- `src/event.ts` - what the triggering event asks the run to triage, including the pull request behind a `workflow_run` event.
  Only `schedule`, `workflow_dispatch` and local runs sweep the backlog.
- `src/failures.ts` - decides whether a failure fails the job or only warns.
- `src/summary.ts` - the job summary and the warning annotations.
- `src/github.ts` - GitHub API boundary, including the contents reads for the policy and README.
  `listRepoLabels` leaves out archived labels, because GitHub won't add them.
- `src/llm/` - the model API boundary, with no SDK.
  `endpoint.ts` picks the Chat Completions endpoint and key for a model input.
  `chat.ts` is the one client every provider goes through, with its retries, per-call deadline, error classification, and undici fetch.
  danielchalmers/Nuntia copies `src/llm/` and `tests/llm/` verbatim, so change them here first and copy them over in a paired PR.
- `src/analysis.ts` and `src/triage.ts` - response schema and operation planning.
  An empty repository label list allows no label, while an undefined one filters nothing, and `findDroppedLabels` names the planned labels the repository lacks for the log and the job summary.
- `src/prompts.ts` and `src/prompt.ts` - reading the policy and README, and prompt assembly.
  `buildSystemPrompt` is a pure function of the policy text, README text and labels, and the context limits are constants there.
- `src/storage.ts` and `src/stats.ts` - persisted triage data and run metrics.
  The triage DB is always `triage-db.json` in the working directory, loaded when present and saved after each item unless the run is a dry run.
- `src/util.ts` - shared error-detail and timestamp helpers.
  `errorMessage` is imported straight from `src/llm/chat.ts`.
- `tests/` - Vitest coverage and examples of expected behavior.
- `action.yml` - public GitHub Action metadata.
- `examples/AutoTriage.prompt` - example starting-point prompt to copy into a repo (not bundled).
- `.github/AutoTriage.prompt` - this repo's own policy: the example prompt plus the MOCK fixture rules that this repo's workflows and CI rely on.
  `tests/examples.test.ts` fails when the two drift apart, so carry every example edit over to it.
- `examples/workflows/` - example workflows.
  They and this repo's triage workflows queue in one job-level `queue: max` group, only the backlog sweep saves the DB cache, and `tests/examples.test.ts` checks both sets.
- `.github/workflows/` - CI expectations.
  This repo's workflows run the action with `uses: ./`, so unlike the examples they keep their checkout step.
  `ci.yml` runs `npm run verify` on every pull request, whatever its base branch, and on every push to main, then dry-runs the action on the pull request.
  A newer push to a pull request cancels that pull request's older CI run.
- `dist/` - generated action bundle.

Read the relevant source and nearby tests before editing. Prefer
repository-local evidence over assumptions from memory.

## Operating Loop

For any change:

1. Inspect the current implementation, tests, and public contract.
2. Make the smallest coherent change.
3. Add or update focused tests when behavior changes.
4. Run the narrowest useful verification first.
5. Run required verification before finishing.
6. Rebuild `dist/` when source, bundled assets, dependencies, or action metadata
   affect runtime output.
7. Summarize what changed, what was verified, and any remaining risk.

If something fails, do not guess. Treat the failure as a missing capability,
broken invariant, stale test, or real regression. Fix the specific cause.

## Required Verification

Default verification:

```bash
npm run typecheck
npm run typecheck:test
npm test
```

When runtime output may change, also run:

```bash
npm run build
git status --porcelain
git diff --exit-code --name-only
```

Docs-only changes usually do not require `npm run build`. Changes to `src/`,
`package.json`, `package-lock.json`, `action.yml`, or bundling behavior require
build verification and updated `dist/` output when the bundle changes.

`npm run verify` runs the default verification, then the build, then `npm run check:dist`, which fails when the build left `dist/` different from what is committed.
CI runs the same script before its dry run of the action.

## Development Commands

- `npm ci` - install dependencies from `package-lock.json`.
- `npm run typecheck` - type-check runtime TypeScript.
- `npm run typecheck:test` - type-check tests.
- `npm test` - run Vitest once.
- `npm run test:watch` - run Vitest in watch mode.
- `npm run dev` - run TypeScript in watch mode.
- `npm run build` - type-check, clean `dist/`, and bundle with `esbuild` into a single minified `dist/index.js` (third-party license notices appended at the end; no source map or code-split chunks).
- `npm run clean` - remove `dist/`.
- `npm run check:dist` - fail when `dist/` has uncommitted changes.
- `npm run verify` - typecheck, typecheck tests, run the tests, build, then check `dist/`.

## Change Rules

### Source Changes

- Keep TypeScript strictness intact.
- Validate or narrow untrusted shapes at boundaries, especially GitHub event
  payloads, action inputs, API responses, stored JSON, and model output.
- Keep external service access isolated behind modules that tests can mock.
- Avoid broad refactors unless they directly reduce risk for the requested
  change.

### Public Action Changes

When changing inputs, defaults, permissions, or runtime behavior:

- Update `action.yml`.
- When removing an input, add it to `REMOVED_INPUTS` in `src/env.ts` with a one-line hint, and update every workflow and example that passes it in the same change, or this repo's own runs fail.
- Update `README.md` when user-facing behavior changes.
- Add or update tests for parsing, defaults, and failure behavior.
- Run `npm run build` and inspect generated `dist/` changes.

### Prompt Changes

When changing prompt loading or the built-in fallback:

- Test reading a policy file through the mocked GitHub client.
- Test built-in label-only fallback behavior.
- Test missing or unreadable policy behavior when applicable.
- Keep the system prompt byte-identical for the same policy and README text unless the change means to alter it.

### Dependency Changes

Before adding a dependency, check whether the existing stack already solves the
problem. New dependencies must be compatible with Node.js 24 and GitHub Actions,
committed in `package-lock.json`, covered by relevant tests, and included in the
rebuilt bundle when used at runtime.

## Testing Expectations

For triage behavior, cover:

- Normal issue or pull request processing.
- Missing, malformed, or partial inputs.
- Model or GitHub API failure paths.
- Dry-run behavior.
- Storage, artifact, or stats changes when touched.

For GitHub integration boundaries, prefer mocked clients and representative
payload fixtures over live network calls. Local development against real GitHub
and a model API requires `GITHUB_TOKEN` and one of `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` (optionally with `OPENAI_BASE_URL`), but
unit tests must not depend on any of them. Model client tests use an injected
fetch or a localhost server.

`tests/setup.ts` clears every `GITHUB_*`, `INPUT_*` and `RUNNER_*` variable before each test file loads and again before each test, so a test sets what it needs with `vi.stubEnv` in `beforeEach` or in the test itself.
Only failing tests print their console output, so spy on `console` only to assert a log line.
`@actions/core` commands such as `group` and `warning` write straight to stdout, which that setting can't hide, so mock them in tests that reach them.

## Failure Recovery

- `npm ci` fails: check Node/npm version and lockfile consistency.
- Typecheck fails: fix types rather than weakening strictness.
- Tests fail: determine whether the failure is a regression, stale expectation,
  missing mock, or environment issue.
- Build fails: inspect the first compiler or bundler error before retrying.
- `dist/` changes unexpectedly: inspect the generated diff before finishing.
- Credentials are missing: do not invent them; report the blocked verification.

## Pull Request Readiness

Before opening or updating a PR:

- Verification has passed, or blocked checks are named with reasons.
- Runtime-impacting changes have rebuilt `dist/`.
- Public behavior changes are reflected in docs and tests.
- Unrelated files are not modified.
- The PR body explains the why, the what, verification, and residual risk.

## Harness Improvement Backlog

These are good follow-up investments because OpenAI's harness engineering post
argues that durable agent leverage comes from legible repository systems,
mechanical checks, and feedback loops rather than repeated manual guidance.

- Add representative GitHub issue, pull request, and comment fixtures for
  behavior tests.
- Add model-response fixtures for planning edge cases.
- Add a periodic documentation freshness check once the project has more
  repository-local design notes.
