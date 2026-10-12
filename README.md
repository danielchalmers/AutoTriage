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
4. Optionally commit your own policy to `.github/AutoTriage.prompt` on the default branch, starting from the [example prompt](./examples/AutoTriage.prompt). The workflow needs no checkout step, because AutoTriage reads the policy through the API (see [Policy and README](#policy-and-readme)).

For event-specific workflows, start from the examples in [`examples/workflows`](./examples/workflows/):

- [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) — run on issue events.
- [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) — run on pull request events.
- [`autotriage-comments.yml`](./examples/workflows/autotriage-comments.yml) — re-triage when someone replies.
- [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) — scheduled backlog sweep.

The examples share one job-level `concurrency` group with `queue: max`, so a burst of runs waits its turn instead of being cancelled. Only the backlog sweep saves the triage history cache, because GitHub gives `issues`, `pull_request_target` and `issue_comment` runs read-only cache access. The comments example restores it to see when an item was last triaged.

**What each event triages.** An `issues`, `issue_comment`, `pull_request` or `pull_request_target` event triages the item it names. A `workflow_run` event triages the pull request behind the run it reports, so a small signal workflow on `pull_request` can stand in for `pull_request_target`, fork PRs included. Run the triage job only when `github.event.workflow_run.conclusion == 'success'`. AutoTriage finds the PR itself, and skips drafts, closed PRs and trigger runs that weren't created within 10 minutes of the PR being opened or marked ready for review. Only `schedule` and `workflow_dispatch` runs sweep the backlog. Any other event, such as `push`, triages nothing and leaves a notice. A non-blank `issues` input overrides all of these.

## How it works

For each item — the triggering issue/PR, an explicit `issues` list, or the backlog on a schedule or dispatch run — AutoTriage gathers the body, full timeline, repository labels, your policy and your README. One call to the model then plans operations, each citing its authorizing policy clause, and they're applied through the GitHub API (or only logged in dry-run).

Just before applying a plan, AutoTriage checks that the item hasn't changed since it was read. If it has, the item is analyzed once more with its latest state, which counts against `max-pro-runs`. That plan is applied unless the item changed yet again, in which case the item is deferred and the job summary lists it.

Overloads and rate limits are waited out. Each request to the model gets up to 10 minutes, and a whole call gets 15 minutes counting its retries and waits, after which that item fails with a warning. While a request is waiting, the log notes each minute that passes. A model error that no retry can fix, such as a rejected API key, an unknown model, or an account out of credit, stops the run and fails the job right away. A reply the model refuses, or cuts off at its output limit, fails that item.

The log gives each model call's time and tokens, and explains each plan with its summary and the policy clause behind each operation. Comments carry the same explanation in a hidden block:

```text
💭 Asking gemini-3.5-flash-lite...
Answered in 8.2s • 3.1k input • 85 output • 1.9k reasoning
Summary: Docs-only PR from a maintainer that updates the cookie consent prompt design.
Operations:
- add_labels: Label documentation-only changes docs.
🏷️ Labels: +docs
```

## Policy and README

AutoTriage reads your policy from `.github/AutoTriage.prompt` and your README from the repository root, where it's the file named README in any case, with no extension or `.md`, `.markdown` or `.txt`. Without a policy file, the built-in label-only policy applies, and the README is optional. Both are read through the GitHub API at the commit the run is for (`GITHUB_SHA`), never from a checkout, so the workflow needs `contents: read` but no checkout step. That commit depends on the event:

- `issues`, `issue_comment`, `schedule` and `workflow_run`: the head of the default branch.
- `workflow_dispatch`: the head of the branch you run it from, which is the default branch unless you pick another.
- `pull_request_target`: the head of the pull request's base branch, usually the default branch.
- `pull_request`: the pull request's merge commit, so the pull request's own copy of the policy applies. This repository's CI uses that on purpose, to dry-run a pull request's policy edits. It's safe because GitHub gives `pull_request` runs from forks no secrets and a read-only token.
- A local run, which has no `GITHUB_SHA`: the default branch.

So under every event except `pull_request`, a pull request can't change the policy that triages it.

The log and the job summary name both sources, such as `Policy: .github/AutoTriage.prompt at 1a2b3c4` or `Policy: built-in`, and `README: README.md at 1a2b3c4` or `README: none`. AutoTriage first lists the repository's root files, which also finds the README's real name. If GitHub refuses that listing, the token can't read the repository's contents, so the run fails and asks for `contents: read`. A private repository answers such a token with a 404. A GitHub outage or rate limit while reading either file stops the run with a warning before anything is triaged, rather than triaging with the built-in policy in place of yours.

## Models

Set one model API key as a secret and map it in the step's `env`. AutoTriage talks to every provider through its OpenAI-compatible Chat Completions API.

| API key | Default model | Served by |
| --- | --- | --- |
| `GEMINI_API_KEY` | `gemini-3.5-flash-lite` | Gemini's OpenAI-compatible API |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` | Claude's OpenAI SDK compatibility API |
| `OPENAI_API_KEY` | `gpt-6-luna` | OpenAI |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model` | any OpenAI-compatible service |

- With one key set, every model goes to it, and a blank `model` uses its default.
- With several keys set, a `gemini-*` or `claude-*` model goes to Gemini or Claude when that key is set, and any other model goes to OpenAI or `OPENAI_BASE_URL`. A blank `model` with several keys set fails the run as a configuration error, so set `model` or map only one key. `OPENAI_BASE_URL` counts as a key here.
- The log names the model, host and reasoning setting, such as `Model: gpt-6-luna at api.openai.com (default for OPENAI_API_KEY), reasoning: high.` For Claude it says `reasoning: provider default (api.anthropic.com ignores reasoning_effort)`, and where a provider reports no reasoning tokens, the log says `reasoning not reported`.

**Any OpenAI-compatible service** (OpenRouter, Azure OpenAI, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Cerebras, LiteLLM, vLLM, Ollama, ...) works by setting `OPENAI_BASE_URL` to its API base, such as `https://openrouter.ai/api/v1`, and `model` to a model it serves. For Azure OpenAI, use `https://<resource>.openai.azure.com/openai/v1` and your deployment name as the model. The key is optional for a local server such as Ollama on a self-hosted runner. `OPENAI_BASE_URL` must use https (plain http is allowed only for localhost) and can't include a user name or password, and redirects aren't followed.

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
| `issues` | Issue or PR numbers separated by spaces or commas, such as `12, #34`. | the event's item, or the backlog on `schedule` or `workflow_dispatch` |
| `max-pro-runs` | Maximum model analyses per run. | `20` |
| `model` | Model to use. Blank uses the default for the API key you map (see [Models](#models)). | `""` (default for your key) |

A `dry-run` or `extended` value other than true or false, or an `issues` value that isn't a list of issue or PR numbers, fails the run before anything is triaged. So does passing an input that AutoTriage no longer takes, such as `model-pro` or `prompt-path`, even with a blank value, and the error says what to do with each one.

## Job summary

Once its configuration checks out, every run writes a job summary to its page on GitHub. It shows:

- the mode, the model, the policy file (or the built-in policy) and the README, with the commit they were read at, and the prompt hash;
- for a `workflow_run` event, the pull request it led to and how AutoTriage found it, such as `PR #12 (fork lookup by pat:fix-typo, head SHA matched)`;
- a notice when the event had nothing to triage, and why;
- the items the run acted on, or would have in a dry run, with their operations;
- each failed or deferred item, and any items a run cap or an early stop left out, with the reason;
- the item counts and the model's token counts.

Each failed or deferred item also gets a warning annotation. GitHub shows up to 10 warnings per step, so any more are merged into one.

**When the job fails.** A run fails only when something needs fixing:

- a configuration error at startup, such as a missing token or key, an invalid or removed input, or a blank `model` with several keys set;
- a model error that every item would hit, such as a rejected API key, an unknown model, or an account out of credit;
- a GitHub error that means the token or the workflow's permissions are wrong: HTTP 401, a 403 that isn't a rate limit, or a 404 for the listing of the repository's files, which is how a private repository answers a token without `contents: read`;
- an unexpected error, which points to a bug in AutoTriage.

Everything else only warns, so a provider's bad day doesn't turn your runs red. That covers model overloads, rate limits and timeouts, replies that are malformed, refused or cut off, deferred items, GitHub outages, rate limits and network errors, including one that stops the run before it can read the policy, and a run that stops after three items in a row fail. An event with nothing to triage ends the run green with a notice.

## Run summary

Each run writes a machine-readable `run-summary.json` to the `artifacts/` directory, alongside the system prompt (`prompt-system.md`) and the per-issue prompts and analyses. It mirrors the `📊 Run Statistics` log in structured form so runs can be aggregated across history rather than scraped from logs. Its `schemaVersion` is 5. It includes:

- `model` — the model ID the run sent.
- `config` / `promptHash` — the run's effective settings and a truncated hash of the assembled system prompt, so runs can be segmented by configuration and policy version.
- `github` — the number of GitHub API calls the run made.
- `funnel` — items discovered and processed; how many processed items were `triaged`, `deferred` (the item changed during its final analysis, or couldn't be rechecked, so its plan wasn't applied) or `failed`; and whether `max-pro-runs` stopped the run (`capReached`). The three outcome counts add up to `processed`.
- `usage` — the number of model calls, their duration percentiles and their token usage, including `cachedInputTokens` and `reasoningTokens` (the reasoning tokens a provider reports, which output tokens exclude here).
- `items` — per-item rows with outcome, whether the item changed during analysis and was analyzed again (`reanalyzed`, where the row describes the second analysis and its `usage` covers both), what the model planned (`plan`: the operation kinds and signed label changes such as `+bug`), the item's model time and tokens (`usage`), the operations performed, and for failures, why (`failureReason`: `capacity`, `retryable`, `permanent` or `fatal` for a model error, or `other` for an error outside the model call).

Upload it by including `artifacts/` in your workflow's `upload-artifact` step.
