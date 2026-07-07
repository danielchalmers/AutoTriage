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
- Default runtime prompt: with no `.github/AutoTriage.prompt` configured, the
  built-in label-only prompt (`src/prompt.ts`) is used. The
  `examples/AutoTriage.prompt` file is a copy-paste starting point, not bundled.
- Unit tests must not require real GitHub or Gemini credentials.
- Public action behavior must stay aligned across `action.yml`, `README.md`,
  tests, and generated `dist/`.

## Context Map

Start with the smallest useful context:

- `src/index.ts` - action entry point.
- `src/config.ts` and `src/env.ts` - action inputs and environment handling.
- `src/runner.ts` and `src/issueProcessor.ts` - orchestration and per-item work.
- `src/github.ts` - GitHub API boundary.
- `src/gemini.ts`, `src/analysis.ts`, `src/triage.ts` - model analysis and
  operation planning.
- `src/prompts.ts` and `src/prompt.ts` - prompt loading and prompt assembly.
- `src/storage.ts` and `src/stats.ts` - persisted triage data and run metrics.
- `tests/` - Vitest coverage and examples of expected behavior.
- `action.yml` - public GitHub Action metadata.
- `examples/AutoTriage.prompt` - example starting-point prompt to copy into a repo (not bundled).
- `.github/workflows/` - CI expectations.
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

## Development Commands

- `npm ci` - install dependencies from `package-lock.json`.
- `npm run typecheck` - type-check runtime TypeScript.
- `npm run typecheck:test` - type-check tests.
- `npm test` - run Vitest once.
- `npm run test:watch` - run Vitest in watch mode.
- `npm run dev` - run TypeScript in watch mode.
- `npm run build` - type-check, clean `dist/`, and bundle with `ncc`.
- `npm run clean` - remove `dist/`.

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
- Update `README.md` when user-facing behavior changes.
- Add or update tests for parsing, defaults, and failure behavior.
- Run `npm run build` and inspect generated `dist/` changes.

### Prompt Changes

When changing prompt loading or the built-in fallback:

- Test custom prompt path behavior.
- Test built-in label-only fallback behavior.
- Test missing or invalid prompt behavior when applicable.

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
or Gemini requires `GITHUB_TOKEN` and `GEMINI_API_KEY`, but unit tests should not
depend on either.

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

- Add `npm run verify` to run typecheck, test typecheck, tests, build, and the
  `dist/` freshness check in one command.
- Add a focused `npm run check:dist` script so local and CI checks share the
  same generated-output invariant.
- Add representative GitHub issue, pull request, and comment fixtures for
  behavior tests.
- Add model-response fixtures for Gemini planning edge cases.
- Add structural tests for action input metadata and README input documentation
  alignment.
- Add a periodic documentation freshness check once the project has more
  repository-local design notes.
