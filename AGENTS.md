# AGENTS.md

Guidance for agents working in this repository.

## Project

AutoTriage is a Node 24 GitHub Action written in TypeScript. Source lives in `src/`, tests live in `tests/`, and the action entrypoint is the generated `dist/index.js`.

## Ground Rules

- Never edit `dist/` by hand. Regenerate it with `npm run build`.
- Keep changes scoped to the request. Avoid drive-by refactors, formatting churn, and unrelated dependency updates.
- Prefer existing patterns and local helpers over new abstractions.
- Use ASCII unless the touched file already uses non-ASCII or the content requires it.

## Commands

- Install dependencies: `npm ci`
- Type-check source: `npm run typecheck`
- Type-check tests: `npm run typecheck:test`
- Run tests: `npm test`
- Build action bundle: `npm run build`
- Watch TypeScript: `npm run dev`

Run the smallest useful verification first. For source changes that affect runtime behavior, run `npm run typecheck`, `npm test`, and `npm run build` when practical.

## Build And Dist

`dist/` is committed because GitHub Actions executes `dist/index.js` directly. Any change to runtime source, bundled assets, dependencies, or action metadata may require `npm run build`.

CI checks that generated `dist/` output is current. If `npm run build` changes `dist/`, keep those generated changes with the source change unless the user asked for analysis only.

## Behavior And Safety

`README.md` and `action.yml` describe the public action contract. Keep them aligned with behavior changes.

AutoTriage may apply labels, comments, title changes, and issue state changes. Preserve default-deny authorization behavior unless the user explicitly asks to change it.

Do not downgrade Node, `package.json` engines, or `action.yml` runtime without explicit request.

## Tests

Tests use Vitest and should protect behavior, not just increase count.

Add or keep tests when they:

- Assert observable behavior, data shape, side effects, or error handling.
- Cover a regression, boundary case, integration contract, or permission/safety rule.
- Would fail for a realistic broken implementation.

Avoid or remove low-quality tests when they:

- Only assert that a function "does not throw" without checking meaningful output.
- Duplicate another test with different names but the same behavior.
- Mirror implementation details so closely that refactors break tests without behavior changing.
- Check trivial getters, setters, constants, or framework wiring unless those are part of a public contract.
- Require broad mocks or fragile setup for little behavioral coverage.

Prefer one focused test with strong assertions over several weak variations. When cleaning tests, preserve coverage for risky paths such as GitHub API calls, prompt construction, cache behavior, triage operation planning, database updates, and `dist` build expectations.

## Runtime Inputs

Local action runs need:

- `GITHUB_TOKEN`
- `GEMINI_API_KEY`

Unit tests should not require real GitHub or Gemini credentials. Use mocks for API boundaries.
