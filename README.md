# AutoTriage — AI issue & pull request triage for GitHub

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-AutoTriage-blue?logo=github)](https://github.com/marketplace/actions/autotriage)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

AutoTriage is a GitHub Action that triages issues and pull requests against a plain-text policy in your repo: it applies labels, asks for missing details, retitles unclear reports, and handles stale items. It runs in your existing workflow and calls the Gemini API with your key — no bot to host, no third-party service.

## Why

- **The policy is a markdown file**, not code — triage rules live in `.github/AutoTriage.prompt`, versioned and reviewed like everything else. Without one, a built-in label-only policy works out of the box.
- **Deny-by-default.** The model can only emit five operation kinds — add/remove labels, comment, retitle, change state — and each operation must cite the policy clause that authorizes it. It cannot push code, edit issue bodies, or merge PRs. Ambiguous authorization means no action.
- **Dry-run first.** With `dry-run: "true"`, the full plan and reasoning are logged without changing anything.
- **Bounded cost.** An optional fast-model gate screens items before the review model, and per-run caps keep backlog sweeps predictable. You pay only for Gemini tokens on your own key.
- **Auditable.** Every run uploads per-item reasoning transcripts and a machine-readable `run-summary.json`.
- **Proven in production.** [MudBlazor](https://github.com/MudBlazor/MudBlazor) runs AutoTriage on every new issue, PR, and comment — see their [workflow runs](https://github.com/MudBlazor/MudBlazor/actions) and [policy prompt](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## Quick start

1. Add a `GEMINI_API_KEY` secret to your repository or organization ([get a key](https://aistudio.google.com/apikey)).
2. Add a workflow:

```yaml
name: AutoTriage

on:
  pull_request_target:
    types: [opened]
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: danielchalmers/AutoTriage@v4
        with:
          issues: ${{ github.event.pull_request.number || github.event.issue.number }}
          dry-run: "true" # change to "false" after reviewing the plan output
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

3. Open a test issue, review the plan in the workflow logs, then set `dry-run: "false"`.
4. Optionally write your own policy at `.github/AutoTriage.prompt`, starting from the [example prompt](./examples/AutoTriage.prompt).

For event-specific workflows, start from the examples in [`examples/workflows`](./examples/workflows/):

- [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) — run on issue events.
- [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) — run on pull request events.
- [`autotriage-comments.yml`](./examples/workflows/autotriage-comments.yml) — re-triage when someone replies.
- [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) — scheduled backlog sweep.

## How it works

For each item — the triggering issue/PR, an explicit `issues` list, or auto-discovered backlog — AutoTriage gathers the body, full timeline, repository labels, and your policy. If `model-fast` is set, a cheap model screens the item first and clear no-ops stop there. The review model then plans operations, each citing its authorizing policy clause, and they're applied through the GitHub API (or only logged in dry-run).

A real reasoning transcript from MudBlazor's runs:

> 💭 Thinking with gemini-3.1-flash-lite...
>
> Okay, so I've got a pull request to triage. It's titled "Docs: Update cookie consent prompt design," so immediately I'm thinking documentation updates. The author is a maintainer — they're likely familiar with the project's standards. Now, let's consult the ASSISTANT BEHAVIOR POLICY. Since the author is a maintainer, I can skip sections related to encouraging contributions and missing information. The main thing I need to focus on is labeling. The title starts with "Docs:", and the changes are specifically about the documentation site, which makes the `docs` label the most appropriate. No comments or state changes are needed. The title is fine as it is.
>
> 🏷️ Labels: +docs

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `additional-instructions` | Extra prompt instructions for this run. | — |
| `budget-scale` | Multiplier for prompt context limits. | `1` |
| `db-path` | Path to the triage history JSON file. | — |
| `dry-run` | Log planned actions without applying changes. | `"false"` |
| `extended` | Broaden backlog auto-discovery. | `"false"` |
| `issues` | Space or comma separated issue or PR numbers. | event target or backlog |
| `max-fast-runs` | Maximum fast-model analyses per run. | `100` |
| `max-pro-runs` | Maximum review-model analyses per run. | `20` |
| `model-fast` | Fast-pass model. Leave blank to skip. | `""` (skip) |
| `model-pro` | Review model for final planning. | `gemini-3.1-flash-lite` |
| `prompt-path` | Repo-relative path to the triage prompt. | `.github/AutoTriage.prompt` |
| `strict-mode` | Fail the job when any item analysis fails. | `"false"` |

> [!IMPORTANT]
> AutoTriage is officially supported with Gemini 3 models. Other Gemini model families may still work, but they are considered use-at-your-own-risk.

## Run summary

Each run writes a machine-readable `run-summary.json` to the `artifacts/` directory (alongside the per-issue prompts and analyses). It mirrors the `📊 Run Statistics` log in structured form so runs can be aggregated across history rather than scraped from logs. It includes:

- `funnel` — items discovered, processed, triaged, skipped, escalated to the pro pass, which run cap was hit, and skip reasons.
- `fast` / `pro` — per-pass duration percentiles and token usage, including `thoughtsTokens` (the hidden thinking budget Gemini bills but excludes from output tokens).
- `items` — per-item rows with outcome, pass timing/tokens, and the operations performed.

Upload it by including `artifacts/` in your workflow's `upload-artifact` step.

## License

[MIT](./LICENSE)
