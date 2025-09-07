AutoTriage — AI-powered GitHub triage bot

Overview
- AutoTriage is a reusable GitHub Action that uses a project-specific prompt and Gemini to: apply labels, request missing info via comments, optionally edit titles, and close issues when appropriate.
- It is written in TypeScript, bundles with ncc, and exposes lean inputs for easy reuse across repositories.

Quick Start
- Add a project policy prompt file (recommended path): `.github/scripts/AutoTriage.prompt`. See `examples/AutoTriage.prompt` for a starter template.
- Add a workflow in your repo:

  .github/workflows/autotriage.yml
  on:
    issues:
      types: [opened, edited]
  permissions:
    contents: read
    issues: write
  jobs:
    triage:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: AutoTriage (issues)
          uses: <owner>/AutoTriage@v0
          with:
            prompt-path: .github/scripts/AutoTriage.prompt
            enabled: true
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

Inputs
- `issue-number`: Specific issue to process; defaults to the current event’s item if available.
- `issue-numbers`: Space- or comma-separated list of issue numbers to process.
- `prompt-path`: Path to your project policy prompt file (default: `.github/scripts/AutoTriage.prompt`).
- `enabled`: When `true`, performs write actions (labels/comments/close). When `false`, runs in dry-run mode and only logs. Default: `true`.
- `db-path`: Optional path to a JSON file for maintaining minimal state per issue: last triaged time, a canonical issue summary (for duplicate detection), and the full cumulative reasoning history.
- `model-fast` / `model-pro`: Gemini model names (defaults: `gemini-2.5-flash`, `gemini-2.5-pro`).
- `model-temperature`: Sampling temperature for the model output (default: 1.0).
- `max-timeline-events`: Limit of recent timeline events included in the prompt (default: 50).
- `max-operations`: Maximum number of operations to perform across the entire run before exiting early (default: 10).

Labeling behavior
- Suggested labels are filtered against the repository's existing label set. The action fetches labels from the repo and ignores any labels that do not exist.

Permissions
- Minimum required: `issues: write`, `contents: read`.
- If labeling PRs or commenting on PRs, the Issues API is used for labeling/commenting; `issues: write` is sufficient in most cases.

Examples
1) Single-issue triage from an issue-opened event
  - See `.github/workflows/example-issues.yml` in this repo.

2) Backlog triage (manual or scheduled, with cache)
  on:
    workflow_dispatch:
      inputs:
        issues:
          description: "Space-separated issue numbers"
          required: false
    schedule:
      - cron: "0 3 * * *"
  jobs:
    triage:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: Restore triage DB
          uses: actions/cache@v4
          with:
            path: triage-db.json
            key: ${{ runner.os }}-triage-db-${{ github.run_id }}
            restore-keys: |
              ${{ runner.os }}-triage-db-
        - name: AutoTriage (batch)
          uses: <owner>/AutoTriage@v0
          with:
            prompt-path: .github/scripts/AutoTriage.prompt
            issue-numbers: ${{ github.event.inputs.issues }}
            db-path: triage-db.json
            enabled: true
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        - name: Upload artifacts
          if: always()
          uses: actions/upload-artifact@v4
          with:
            name: triage-artifacts-${{ github.run_number }}
            path: |
              triage-db.json
              artifacts/

Project Prompt
- Your project policy lives at `.github/scripts/AutoTriage.prompt`. The action injects the item body, metadata, timeline, triage context, and an output contract.
- Keep the policy concise and explicit. Use Markdown (HTML) comments `<!-- ... -->` for editor-only notes; the assistant ignores anything inside these comments.
- A minimal starter template is included; customize labels, rules, links, and tone for your project.

Analysis Flow
- Two-pass analysis: a quick pass (fast model) followed by a review pass (pro model) when needed.
- If the quick pass proposes any operations or fails, the review pass runs and may critique/confirm the quick result. Actions are taken only from the review pass.

Artifacts
- The action saves per-issue artifacts under `./artifacts` in the runner workspace: Gemini inputs, raw outputs by model for each stage (quick/review), and planned operations.

Backlog Example
- A complete backlog workflow demonstrating cache and artifact upload is provided at `examples/workflows/batch-triage.yml`. Copy it into `.github/workflows/` in your repo to enable the schedule/dispatch flow.

Local Development
- Requirements: Node 20+, npm.
- Install deps: `npm install`
- Typecheck: `npm run typecheck`
- Build (bundled): `npm run build`
- VS Code: tasks for build/typecheck/watch and a launch config that runs `dist/index.js`.

Implementation Notes
- Uses `@actions/core` and `@actions/github` to interact with the GitHub API.
- Uses Node 20 native `fetch` for Gemini calls (no `node-fetch` dependency).
- Bundled with `@vercel/ncc` for distribution.

Security
- Store your Gemini API key as `GEMINI_API_KEY` in repository secrets.
- The action uses the default `GITHUB_TOKEN` with minimal permissions.

License
- MIT
