# AutoTriage — AI issue & pull request triage for GitHub

[![CI](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/AutoTriage?label=latest)](https://github.com/danielchalmers/AutoTriage/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

AutoTriage is a GitHub Action that triages issues and pull requests with an AI model, following a plain-text policy in your repo. It can apply labels, ask for missing details, retitle unclear reports and handle stale items. It runs in your own workflow with your own model key, so there's no bot to host.

[MudBlazor](https://github.com/MudBlazor/MudBlazor) runs it on every new issue and PR, plus a nightly backlog sweep, with this [policy](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## Quick start

1. Add a model API key as a repository or organization secret: `GEMINI_API_KEY` ([get a free key](https://aistudio.google.com/apikey)), `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
2. Add [`.github/workflows/autotriage.yml`](./examples/workflows/autotriage.yml). It triages new issues, pull requests and comments:

```yaml
name: AutoTriage

on:
  issues:
    types: [opened, reopened]
  pull_request_target:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      issues:
        description: 'Issue or PR numbers (blank = backlog)'

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  triage:
    # Skip draft PRs, and issues and comments from bots.
    if: >-
      (github.event_name == 'pull_request_target' && !github.event.pull_request.draft) ||
      (github.event_name != 'pull_request_target' && github.event.sender.type != 'Bot')
    runs-on: ubuntu-latest
    timeout-minutes: 60
    concurrency:
      group: autotriage
      queue: max
    steps:
      - uses: danielchalmers/AutoTriage@v5
        with:
          issues: ${{ inputs.issues }}
          dry-run: "true" # change to "false" after reviewing the plan output
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

3. Open a test issue, check the plan in the run's job summary, then set `dry-run: "false"`.

To triage existing items once, run the workflow manually with `issues` left blank. Time-based policy rules, such as the example's stale handling, only fire from a scheduled sweep, so add [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) if your policy has them.

## Policy and labels

Without a policy file, AutoTriage only adds labels. It picks from your repository's labels by name and description, so give each label a description that says when it applies, such as "Reports or fixes something that is broken" for `bug`.

To do more, such as asking for details, retitling or closing stale items, write a policy at `.github/AutoTriage.prompt`, starting from the [example](./examples/AutoTriage.prompt). Every action the model plans has to cite the policy clause that allows it.

## How it works

- A run triages the triggering issue or PR, the numbers in `issues`, or, with neither, a backlog sweep. A sweep takes new and changed items first, then the rest, longest since triaged first, plus recently closed items with new activity.
- A run analyzes at most `max-runs` items. A sweep tells what changed from the triage history at `db-path`, which the [backlog example](./examples/workflows/autotriage-backlog.yml) caches between runs.
- The policy and README are read from the repository at the run's commit, so the job needs no checkout. A checked-out file is used instead when there is one.
- Text in an issue or comment can't authorize anything. An item whose title or body tries to instruct the bot, or to get its instructions, is handled by your policy's rules for spam, and a comment that tries it is ignored.
- Just before applying a plan, AutoTriage checks the item again. If it changed, the item is analyzed once more. If it changes again, the plan is skipped, and the job summary says what it was and to re-run the job.
- Overloads and rate limits are waited out for a few minutes per call. A used-up daily quota, such as the Gemini free tier's, isn't waited out, so the run stops early with a warning.

## Models

| API key | Default model |
| --- | --- |
| `GEMINI_API_KEY` | `gemini-3.5-flash-lite` |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `OPENAI_API_KEY` | `gpt-6-luna` |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model` |

- Set `model` to use another model. With several keys mapped, `gemini-*` and `claude-*` models go to their own provider and anything else goes to OpenAI or `OPENAI_BASE_URL`. A blank `model` with several keys mapped fails the run.
- Any OpenAI-compatible service, such as OpenRouter, Azure OpenAI, Groq or Ollama, works by setting `OPENAI_BASE_URL` to its API base, which must use https except on localhost.
- Issue and pull request text goes to the provider you pick.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `dry-run` | Log planned actions without applying them. Must be `true` or `false`. | `"false"` |
| `issues` | Issue or PR numbers, separated by spaces or commas, such as `12, #34`. | the triggering item, or a sweep |
| `model` | Model to use. Blank uses your key's default. | `""` |
| `max-runs` | Maximum items to analyze per run, counting ones that fail. | `50` |
| `prompt-path` | Path to the policy. Without the default file, the built-in label-only policy is used, but any other path must exist. | `.github/AutoTriage.prompt` |
| `db-path` | Path to the triage history file, for sweeps. | — |
| `additional-instructions` | Extra policy text for this run. | — |
| `budget-scale` | Multiplier for how much of each item, its timeline and the README the model sees. | `1` |

## Results

Every run writes a job summary with the model, the policy, the items it acted on (or would have, in a dry run) and anything that failed or was left out. The `artifacts/` directory holds the prompts, each plan and a machine-readable `run-summary.json`. Upload it with `actions/upload-artifact` to keep it.

A run fails only when something needs fixing: invalid configuration, a rejected key or unknown model, missing permissions, or a bug in AutoTriage. Provider outages, rate limits and bad replies only show as warnings.
