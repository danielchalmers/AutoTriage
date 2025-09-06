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
- `enabled`: When `true`, performs write actions (labels/comments/close). When `false`, runs in dry-run mode and only logs.
- `db-path`: Optional path to a JSON file for maintaining minimal state (e.g., last triaged time and last reasoning per issue).
- `model-fast` / `model-pro`: Gemini model names (defaults: `gemini-2.5-flash`, `gemini-2.5-pro`).
- `label-allowlist`: Optional comma-separated list of labels; suggested labels outside this set are ignored.
- `max-timeline-events`: Limit of recent timeline events included in the prompt (default: 50).

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
- The prompt is your policy and labeling logic. The action injects the item body, metadata, timeline, triage context, and an output contract. Keep it concise and explicit.
- Start with `examples/AutoTriage.prompt` and customize labels, rules, and tone for your project.

Artifacts
- The action saves per-issue artifacts under `./artifacts` in the runner workspace: Gemini input, raw outputs by model (flash/pro), and parsed analyses.

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
