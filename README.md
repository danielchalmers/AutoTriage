# AutoTriage — AI issue & pull request triage for GitHub

[![CI](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/AutoTriage?label=latest)](https://github.com/danielchalmers/AutoTriage/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

AutoTriage is a GitHub Action that triages issues and pull requests against a plain-text policy in your repo: it applies labels, asks for missing details, retitles unclear reports, and handles stale items. It runs in your existing workflow and calls Gemini, Claude, OpenAI, or any OpenAI-compatible service with your key — no bot to host, no third-party service.

[MudBlazor](https://github.com/MudBlazor/MudBlazor) runs AutoTriage on every new issue and PR, plus a nightly backlog sweep — see their [workflow runs](https://github.com/MudBlazor/MudBlazor/actions) and [policy prompt](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## Quick start

1. Add a model API key as a secret in your repository or organization: `GEMINI_API_KEY` ([get a key](https://aistudio.google.com/apikey)), `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Map it in the step's `env` (see [Models](#models)).
2. Add a workflow:

```yaml
name: AutoTriage

on:
  pull_request_target:
    types: [opened]
  issues:
    types: [opened]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    concurrency:
      group: autotriage
      queue: max
    steps:
      - uses: actions/checkout@v7

      - uses: danielchalmers/AutoTriage@v4
        with:
          dry-run: "true" # change to "false" after reviewing the plan output
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

3. Open a test issue, review the plan in the run's job summary and logs, then set `dry-run: "false"`.
4. Optionally write your own policy at `.github/AutoTriage.prompt`, starting from the [example prompt](./examples/AutoTriage.prompt).

For event-specific workflows, start from the examples in [`examples/workflows`](./examples/workflows/):

- [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) — run on issue events.
- [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) — run on pull request events.
- [`autotriage-comments.yml`](./examples/workflows/autotriage-comments.yml) — re-triage when someone replies.
- [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) — scheduled backlog sweep.

The examples share one job-level `concurrency` group with `queue: max`, so a burst of runs waits its turn instead of being cancelled. Only the backlog sweep saves the triage history cache, because GitHub gives `issues`, `pull_request_target` and `issue_comment` runs read-only cache access. The comments example restores it to see when an item was last triaged.

## How it works

For each item — the triggering issue/PR, an explicit `issues` list, or auto-discovered backlog — AutoTriage gathers the body, full timeline, repository labels, and your policy. If `model-fast` is set, a cheap model screens the item first and clear no-ops stop there. The review model then plans operations, each citing its authorizing policy clause, and they're applied through the GitHub API (or only logged in dry-run).

Just before applying a plan, AutoTriage checks that the item hasn't changed since it was read. If it has, the item is analyzed once more with its latest state, which counts against `max-fast-runs` and `max-pro-runs`. That plan is applied unless the item changed yet again, in which case the item is deferred and the job summary lists it.

Overloads and rate limits are waited out. A model error that no retry can fix, such as a rejected API key, an unknown model, or an account out of credit, stops the run and fails the job right away. A reply the model refuses, or cuts off at its output limit, fails that item.

The log explains each plan with its summary and the policy clause behind each operation, and comments carry the same explanation in a hidden block:

```text
💭 Thinking with gemini-3.5-flash-lite...
Summary: Docs-only PR from a maintainer that updates the cookie consent prompt design.
Operations:
- add_labels: Label documentation-only changes docs.
🏷️ Labels: +docs
```

## Models

Set one model API key as a secret and map it in the step's `env`. AutoTriage talks to every provider through its OpenAI-compatible Chat Completions API.

| API key | Default model | Served by |
| --- | --- | --- |
| `GEMINI_API_KEY` | `gemini-3.5-flash-lite` | Gemini's OpenAI-compatible API |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` | Claude's OpenAI SDK compatibility API |
| `OPENAI_API_KEY` | `gpt-6-luna` | OpenAI |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model-pro` | any OpenAI-compatible service |

- With one key set, both passes use it, and a blank `model-pro` uses its default.
- With several keys set, a `gemini-*` or `claude-*` model goes to Gemini or Claude when that key is set, and any other model goes to OpenAI or `OPENAI_BASE_URL`. A blank `model-pro` uses the default of the first key in the table.
- The log names each pass's model and host, such as `Model (pro): gpt-6-luna at api.openai.com (default for OPENAI_API_KEY).`

**Any OpenAI-compatible service** (OpenRouter, Azure OpenAI, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Cerebras, LiteLLM, vLLM, Ollama, ...) works by setting `OPENAI_BASE_URL` to its API base, such as `https://openrouter.ai/api/v1`, and `model-pro` to a model it serves. For Azure OpenAI, use `https://<resource>.openai.azure.com/openai/v1` and your deployment name as the model. The key is optional for a local server such as Ollama on a self-hosted runner. `OPENAI_BASE_URL` must use https (plain http is allowed only for localhost) and can't include a user name or password, and redirects aren't followed.

**What each call asks for.** Every plan is requested as strict JSON that matches the plan schema, with `reasoning_effort: high`. A service that rejects either setting by name gets requests without it for the rest of the run. OpenAI and Gemini enforce the schema. Anywhere else, the schema is also written into the prompt. A reply that isn't a JSON plan is retried, and operations that don't fit the schema are dropped. Claude's compatibility API ignores both settings, so Claude follows the schema from the prompt and thinks at its default effort, and Anthropic describes that API as meant for evaluation rather than production.

**After switching providers**, run with `dry-run: "true"` for a while and review the plans, because the actions are only as good as the model's instruction-following.

**Your data.** Issue and pull request text goes to the provider you pick. Gateways such as OpenRouter forward the text to further providers. Token counts in the run summary follow each provider's own counting, so they aren't comparable across providers.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `additional-instructions` | Extra prompt instructions for this run. | — |
| `budget-scale` | Multiplier for prompt context limits. | `1` |
| `db-path` | Path to the triage history JSON file. | — |
| `dry-run` | Log planned actions without applying changes. Must be `true` or `false`. | `"false"` |
| `extended` | Broaden backlog auto-discovery. | `"false"` |
| `issues` | Issue or PR numbers separated by spaces or commas, such as `12, #34`. | event target or backlog |
| `max-fast-runs` | Maximum fast-model analyses per run. | `100` |
| `max-pro-runs` | Maximum review-model analyses per run. | `20` |
| `model-fast` | Fast-pass model. Leave blank to skip. | `""` (skip) |
| `model-pro` | Review model. Blank uses the default for the API key you set (`gemini-3.5-flash-lite` for `GEMINI_API_KEY`). | `""` (default for your key) |
| `prompt-path` | Repo-relative path to the triage prompt. | `.github/AutoTriage.prompt` |

A `dry-run` or `extended` value other than true or false, or an `issues` value that isn't a list of issue or PR numbers, fails the run before anything is triaged.

## Job summary

Once its configuration checks out, every run writes a job summary to its page on GitHub. It shows:

- the mode, each pass's model, the policy file (or the built-in policy) and the prompt hashes;
- the items the run acted on, or would have in a dry run, with their operations;
- each failed or deferred item, and any items a run cap or an early stop left out, with the reason;
- the item counts and each pass's token counts.

Each failed or deferred item also gets a warning annotation. GitHub shows up to 10 warnings per step, so any more are merged into one.

**When the job fails.** A run fails only when something needs fixing:

- a configuration error at startup, such as a missing token or key, or an invalid input value;
- a model error that every item would hit, such as a rejected API key, an unknown model, or an account out of credit;
- a GitHub error that means the token or the workflow's permissions are wrong: HTTP 401, or a 403 that isn't a rate limit;
- an unexpected error, which points to a bug in AutoTriage.

Everything else only warns, so a provider's bad day doesn't turn your runs red. That covers model overloads, rate limits and timeouts, replies that are malformed, refused or cut off, deferred items, GitHub outages, rate limits and network errors, and a run that stops after three items in a row fail.

## Run summary

Each run writes a machine-readable `run-summary.json` to the `artifacts/` directory, alongside the system prompts (`prompt-system.md`, plus `prompt-system-fast.md` when the fast pass runs) and the per-issue prompts and analyses. It mirrors the `📊 Run Statistics` log in structured form so runs can be aggregated across history rather than scraped from logs. Its `schemaVersion` is 5. It includes:

- `models` — the model ID each pass sent. A skipped fast pass is `null`.
- `config` / `promptHash` — the run's effective settings and truncated hashes of the assembled system prompts, so runs can be segmented by configuration and policy version.
- `github` — the number of GitHub API calls the run made.
- `funnel` — items discovered and processed; how many processed items were `triaged`, `skipped` (the fast pass planned nothing), `deferred` (the item changed during its final analysis, or couldn't be rechecked, so its plan wasn't applied) or `failed`; how many reached the review pass (`escalatedToPro`, with or without a fast pass first); which run cap was hit; and `planAgreement` (how often the pro pass confirmed, vetoed, or amended the fast pass's plan). The four outcome counts add up to `processed`.
- `fast` / `pro` — per-pass duration percentiles and token usage, including `cachedInputTokens` and `reasoningTokens` (the reasoning tokens a provider reports, which output tokens exclude here).
- `items` — per-item rows with outcome, whether the review pass ran (`escalatedToPro`), whether the item changed during analysis and was analyzed again (`reanalyzed`, where the row describes the second analysis and its timing and tokens cover both), pass timing/tokens, the operations performed, what each pass planned (`fastPlan` / `proPlan` / `agreement`), and for failures, which pass failed (`failedPass`, where applying the review's plan counts as the review pass) and why (`failureReason`: `capacity`, `retryable`, `permanent` or `fatal` for a model error, or `other` for an error outside the model call).

Upload it by including `artifacts/` in your workflow's `upload-artifact` step.
