# AutoTriage — AI issue & pull request triage for GitHub

[![CI](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/AutoTriage?label=latest)](https://github.com/danielchalmers/AutoTriage/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

AutoTriage is a GitHub Action that triages issues and pull requests against a plain-text policy in your repo: it applies labels, asks for missing details, retitles unclear reports, and handles stale items. It runs in your existing workflow and calls Gemini, Claude, OpenAI, or any OpenAI-compatible service with your key — no bot to host, no third-party service.

[MudBlazor](https://github.com/MudBlazor/MudBlazor) runs AutoTriage on every new issue, PR, and comment — see their [workflow runs](https://github.com/MudBlazor/MudBlazor/actions) and [policy prompt](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## Quick start

1. Add a `GEMINI_API_KEY` secret to your repository or organization ([get a key](https://aistudio.google.com/apikey)). To use Claude or OpenAI instead, add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and map it in the step's `env` in place of `GEMINI_API_KEY` (see [Models](#models)).
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
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
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

Overloads and rate limits are waited out. A model error that no retry can fix, such as a rejected API key, an unknown model, or an account out of credit, stops the run and fails the job right away, even without `strict-mode`. An item the review model refuses is recorded as skipped and isn't sent again until it changes, and a reply cut off at the output token limit fails that item.

A real reasoning transcript from MudBlazor's runs:

> 💭 Thinking with gemini-3.5-flash-lite...
>
> Okay, so I've got a pull request to triage. It's titled "Docs: Update cookie consent prompt design," so immediately I'm thinking documentation updates. The author is a maintainer — they're likely familiar with the project's standards. Now, let's consult the ASSISTANT BEHAVIOR POLICY. Since the author is a maintainer, I can skip sections related to encouraging contributions and missing information. The main thing I need to focus on is labeling. The title starts with "Docs:", and the changes are specifically about the documentation site, which makes the `docs` label the most appropriate. No comments or state changes are needed. The title is fine as it is.
>
> 🏷️ Labels: +docs

## Models

AutoTriage picks the provider from the API key you set, so switching providers is a matter of mapping a different secret in the step's `env`. `model-pro` is only needed to pick a model other than that key's default.

| API key | Default when `model-pro` is blank | Model names it recognizes |
| --- | --- | --- |
| `GEMINI_API_KEY` | `gemini-3.5-flash-lite` | `gemini-*`, `models/...` |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` | `claude-*` |
| `OPENAI_API_KEY` | `gpt-6-luna` | `gpt-*` (not `gpt-oss`), `ft:gpt-*` |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model-pro` | any name, sent unchanged |

- A recognized name, or any name with a `gemini/`, `anthropic/` or `openai/` prefix, goes to that provider. If its key isn't set and neither is `OPENAI_BASE_URL`, the run stops with an error naming the missing key.
- If only one key is set and `OPENAI_BASE_URL` isn't, any other name goes to that provider, so `gemma-*`, preview names and `o3` work without a prefix. With `OPENAI_BASE_URL` set, any other name goes to that endpoint.
- If several keys are set and `model-pro` is blank, the default comes from the first one in the order Gemini, Anthropic, OpenAI. A blank `model-fast` still skips the fast pass, and the two passes may use different providers.
- Write the provider and model with `/`, as in `anthropic/claude-sonnet-5-5`. `provider:model` is rejected, because `:` appears in real model IDs.
- The log states each pass's choice, such as `Model (pro): claude-haiku-5-5 via anthropic [official] — default for ANTHROPIC_API_KEY; set model-pro to change.`

**Any OpenAI-compatible service** (OpenRouter, Azure OpenAI, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Cerebras, LiteLLM, vLLM, Ollama, ...) works by setting `OPENAI_BASE_URL` to its API base and `model-pro` to a model it serves. For Azure OpenAI, use `https://<resource>.openai.azure.com/openai/v1` and your deployment name as the model. The key is optional for a local server such as Ollama on a self-hosted runner. A name whose provider key isn't set is sent to the endpoint unchanged, so `anthropic/claude-sonnet-5.5` reaches Claude on OpenRouter with only `OPENAI_BASE_URL` and `OPENAI_API_KEY`. If `ANTHROPIC_API_KEY` is also set, write `openai/anthropic/claude-sonnet-5.5` to send it to the endpoint. `OPENAI_BASE_URL` must use https (plain http is allowed only for localhost) and can't include a user name or password, redirects aren't followed, and its host is logged on every run.

**Support tiers.** Gemini 3.x on the Gemini API, Claude 5.5 on the Claude API and GPT-6.x on the OpenAI API are official: each has a built-in default and request tests. Other models on those APIs, and everything behind `OPENAI_BASE_URL`, are best effort. A model that rejects the official request, such as `claude-haiku-4-5` without adaptive thinking or `gpt-4.1` without `reasoning_effort`, fails the job with a clear error. For an `OPENAI_BASE_URL` endpoint, the response schema is also written into the prompt, because some hosts accept a schema without enforcing it, and backlog runs don't cache the system prompt there. GitHub Models, Copilot, Vertex AI and Bedrock native auth, and Anthropic's OpenAI-compatible layer aren't supported.

**After switching providers**, run with `dry-run: "true"` for a while and review the plans, because the actions are only as good as the model's instruction-following.

**Reasoning text.** OpenAI's Chat Completions API doesn't return the model's reasoning, and some other hosts don't either. When a reply has no thoughts, the log and the hidden comment block show the plan's summary and the policy clause each operation cites instead.

**Your data.** Issue and pull request text goes to the provider you pick. OpenAI-compatible calls send `store: false`. Anthropic caches the response schema, which includes your label names, for up to 24 hours. Gateways such as OpenRouter forward the text to further providers. Token counts in the run summary follow each provider's own counting, so they aren't comparable across providers.

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
| `model-fast` | Fast-pass model, optionally with a `gemini/`, `anthropic/` or `openai/` prefix. Leave blank to skip. | `""` (skip) |
| `model-pro` | Review model. Blank uses the default for the API key you set (`gemini-3.5-flash-lite` for `GEMINI_API_KEY`). | `""` (default for your key) |
| `prompt-path` | Repo-relative path to the triage prompt. | `.github/AutoTriage.prompt` |
| `strict-mode` | Fail the job when any item analysis fails. | `"false"` |

## Run summary

Each run writes a machine-readable `run-summary.json` to the `artifacts/` directory (alongside the per-issue prompts and analyses). It mirrors the `📊 Run Statistics` log in structured form so runs can be aggregated across history rather than scraped from logs. It includes:

- `models` / `providers` — the model ID each pass sent, and the provider and support tier (`official` or `best-effort`) that served it. A skipped fast pass is `null`.
- `config` / `promptHash` — the run's effective settings and truncated hashes of the assembled system prompts, so runs can be segmented by configuration and policy version.
- `funnel` — items discovered, processed, triaged, skipped, escalated to the pro pass, which run cap was hit, skip reasons, and `planAgreement` (how often the pro pass confirmed, vetoed, or amended the fast pass's plan).
- `fast` / `pro` — per-pass duration percentiles and token usage, including `thoughtsTokens` (the reasoning tokens a provider bills, which every provider's output tokens exclude here) and `cacheCreatedTokens` (prompt tokens written to a cache).
- `items` — per-item rows with outcome, pass timing/tokens, the operations performed, what each pass planned (`fastPlan` / `proPlan` / `agreement`), and for failures, which pass failed (`failedPass`) and why (`failureReason`: a model failure kind such as `capacity` or `truncated`, the fatal cause `auth`, `model` or `quota`, or `other` for an error outside the model call).

Upload it by including `artifacts/` in your workflow's `upload-artifact` step.
