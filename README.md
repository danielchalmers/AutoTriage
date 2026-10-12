# AutoTriage — AI issue & pull request triage for GitHub

[![CI](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/AutoTriage/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/AutoTriage?label=latest)](https://github.com/danielchalmers/AutoTriage/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

AutoTriage is a GitHub Action that triages issues and pull requests. Out of the box it gives each one a kind label, such as `bug` or `enhancement`. With a plain-text policy in your repo, it can also ask for missing details, retitle unclear reports and handle stale items. It runs in your own workflow and calls Gemini, Claude, OpenAI, or any OpenAI-compatible service with your key — no bot to host, no third-party service.

[MudBlazor](https://github.com/MudBlazor/MudBlazor) runs AutoTriage on every new issue and PR, plus a nightly backlog sweep — see their [workflow runs](https://github.com/MudBlazor/MudBlazor/actions) and [policy prompt](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## Quick start

### 1. Add an API key

Add one model API key as a secret in your repository or organization. AutoTriage uses its provider's default model unless you set `model`.

| Secret | Default model |
| --- | --- |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `GEMINI_API_KEY` ([get a key](https://aistudio.google.com/apikey)) | `gemini-3.5-flash-lite` |
| `OPENAI_API_KEY` | `gpt-6-luna` |

Any other OpenAI-compatible service works through `OPENAI_BASE_URL` (see [Models](#models)).

### 2. Add the two workflow files

Copy both files from [`examples/workflows`](./examples/workflows/) into `.github/workflows`. They map `ANTHROPIC_API_KEY`, so if your key is another, map that one instead, and map only one.

[`autotriage.yml`](./examples/workflows/autotriage.yml) triages each new issue, each pull request that the second file signals, and up to 30 items of the backlog every day. You can also run it from the Actions tab:

```yaml
name: AutoTriage

on:
  issues:
    types: [opened]
  # Pull requests arrive through autotriage-pr.yml.
  workflow_run:
    workflows: [AutoTriage PR]
    types: [completed]
  # A daily sweep of up to 30 items, off the busy top of the hour.
  schedule:
    - cron: '23 8 * * *'
  workflow_dispatch:
    inputs:
      issues:
        description: 'Issue or PR numbers (blank sweeps the backlog)'
      dry-run:
        description: 'Dry run (true = no writes)'
        type: boolean
        default: true

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  triage:
    # A signal run that was cancelled or is waiting for approval has nothing to triage yet.
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    # A sweep usually takes minutes. The limit stops a stuck run before it holds the queue for long, since three failed items in a row already end a run.
    timeout-minutes: 120
    concurrency:
      group: autotriage
      queue: max
    steps:
      - uses: actions/cache/restore@v6
        with:
          path: triage-db.json
          key: triage-db-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: triage-db-

      - uses: danielchalmers/AutoTriage@v5
        with:
          # Only a manual run has these inputs, so every other run is live.
          issues: ${{ inputs.issues }}
          dry-run: ${{ inputs.dry-run }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # GEMINI_API_KEY or OPENAI_API_KEY work too. Map only one key.
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      # Issue runs and workflow_run runs from forks get read-only cache access, so only scheduled and manual runs save it.
      # A failed run saves too, so the items it already triaged aren't triaged again next time.
      - if: always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && hashFiles('triage-db.json') != ''
        uses: actions/cache/save@v6
        with:
          path: triage-db.json
          key: triage-db-${{ github.run_id }}-${{ github.run_attempt }}

      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: triage-artifacts-${{ github.run_number }}
          path: |
            triage-db.json
            artifacts/
```

[`autotriage-pr.yml`](./examples/workflows/autotriage-pr.yml) signals the first file when a pull request is opened or marked ready for review:

```yaml
name: AutoTriage PR

# Fork PRs get no secrets, so this run only signals autotriage.yml through workflow_run, and autotriage.yml finds the PR and triages it.
# autotriage.yml listens for this workflow by its name, so keep the two in step.
# There are no guards, so PRs from bots such as Dependabot get a kind label too.
on:
  pull_request:
    types: [opened, ready_for_review]

permissions: {}

jobs:
  signal:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Signalling the AutoTriage workflow to triage this pull request."
```

**Why two files.** From 2026-11-02, GitHub disables `pull_request_target` by default on public repositories, and a `pull_request` run from a fork gets no secrets. So the second file only signals, and `autotriage.yml` runs from the default branch through `workflow_run`, with your secrets, finds the pull request and triages it, fork pull requests included.

**The second file is optional.** Without it, pull requests are triaged by the next sweep instead of when they're opened, as are pull requests with merge conflicts, which get no `pull_request` run. A repository that prefers one file can keep triggering on `pull_request_target` by adding an [Actions event policy](https://docs.github.com/actions/how-tos/administer/control-workflow-execution) scoped to that workflow file that allows every event the file triggers on, such as `pull_request_target`, `issues`, `schedule` and `workflow_dispatch`. A policy is an allowlist, so an event it leaves out silently stops starting the workflow, and a policy that isn't scoped to one file applies to every workflow in the repository. Private repositories aren't affected.

**Try it first.** A manual run is a dry run unless you untick the box, so run the workflow from the Actions tab and read the plans in its job summary before anything changes. Runs for new issues, pull requests and the schedule are live.

### 3. Describe your labels

The model sees each label's name and description, never its color, so give every label a description that says when it applies. Without a policy file, AutoTriage gives every issue and pull request exactly one kind label, whoever opened it. It recognizes kind labels by their descriptions, or by their names when they have none, so GitHub's default labels work too. A starter set, with descriptions written as the rule the model applies:

| Label | Description |
| --- | --- |
| `bug` | Reports or fixes something that is broken, crashes, or behaves differently than intended |
| `enhancement` | Adds or requests a new feature or a visible improvement; not a fix for broken behavior |
| `documentation` | Changes or requests only README, docs or code comments, with no change in behavior |
| `question` | Asks how to use, install or configure it, without reporting a defect or requesting a change |
| `dependencies` | Only updates packages, SDKs, runtimes, or pinned tool and action versions |
| `maintenance` | Build, CI, tests, refactoring or repo tooling, with no change users would notice |
| `good first issue` | A maintainer has said this is small and clear enough for a first-time contributor |
| `help wanted` | A maintainer has said a pull request from someone else would be welcome |

The first six are kind labels, and `dependencies` is the name Dependabot uses, so it reuses the label. The last two are added only once a maintainer has said so.

The built-in policy only adds labels. It never removes or replaces a label, comments, retitles or closes. An item that already has a kind label gets no other one, and a pull request that fixes broken behavior counts as a defect fix whatever its title says. Any other label is added only when the item, or a maintainer's comment on it, clearly meets the label's description. Labels that only name a language, ecosystem or tool, such as Dependabot's `javascript`, are never added, and neither are labels without a description whose meaning is unclear.

Archived labels are hidden from the model, because GitHub won't add them, and a repository with no labels gets none added. When the model plans a label the repository doesn't have or has archived, the log and the job summary name it as dropped, and the rest of the plan still applies.

### 4. Optional: write a policy

To do more than labeling, such as asking for missing details, retitling unclear reports or closing stale items, copy [`examples/AutoTriage.prompt`](./examples/AutoTriage.prompt) to `.github/AutoTriage.prompt` on your default branch and edit it. The model may only plan operations that a clause of your policy allows, and it cites that clause for each one. The example also uses the labels `invalid` and `stale`, so create those too. To try a policy before it goes live, commit it to a branch and start a manual dry run from that branch, which reads the branch's policy.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `issues` | Issue or PR numbers separated by spaces or commas, such as `12, #34`. | the event's item, or the backlog on `schedule` or `workflow_dispatch` |
| `dry-run` | Log planned actions without applying changes. Must be `true` or `false`. | `"false"` |
| `model` | Model to use. Blank uses the default for the API key you map (see [Models](#models)). | `""` (default for your key) |

A `dry-run` value other than true or false, or an `issues` value that isn't a list of issue or PR numbers, fails the run before anything is triaged. So does passing an input that AutoTriage no longer takes, even with a blank value, and the error says what to do with each one (see [Migrating from v4](#migrating-from-v4)).

## How runs work

**Events.**

- An `issues`, `issue_comment`, `pull_request` or `pull_request_target` event triages the item it names.
- A `workflow_run` event triages the pull request behind the run it reports. AutoTriage finds it from fields GitHub sets: the run's own pull request entry for a same-repository pull request, or else the open pull requests from the run's head branch, preferring the one at the run's head commit. It skips drafts, closed pull requests and signal runs that weren't created within 10 minutes of the pull request being opened or last marked ready for review, and says why in a notice. Run the job only when `github.event.workflow_run.conclusion == 'success'`, as the example does, so a signal run that was cancelled or is waiting for approval doesn't count.
- Only `schedule` and `workflow_dispatch` runs sweep the backlog. Any other event, such as `push`, triages nothing and leaves a notice.
- A non-blank `issues` input overrides all of these, and runs in full however long it is.

**Each item.** AutoTriage gathers the item's body and full timeline, the repository's labels, your policy and your README. One call to the model then plans operations, and they're applied through the GitHub API, or only logged in a dry run. Just before applying a plan, AutoTriage checks that the item hasn't changed since it was read. If it has, the item is analyzed once more with its latest state, and if it changed yet again, it's deferred and the job summary lists it.

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

**Sweeps.** A sweep triages at most 30 items and leaves the rest of its queue for the next sweep. The queue starts with the open items that are new or have changed since they were last triaged, most recently updated first. With a policy file, it goes on with the unchanged open items, least recently triaged first, and recently closed items that were triaged before and have had activity since, so a policy can act on time, such as following up on stale items. With the built-in policy, a sweep takes only new and changed items, because the built-in policy has nothing to add to an item that hasn't changed.

**Triage history.** AutoTriage keeps when it last triaged each item, and the item's update time it saw then, in `triage-db.json` in the working directory. It reads the file when it's there, and writes it after each item unless the run is a dry run. Without the file, every item counts as new, so the example restores it from the cache on every run. Only scheduled and manual runs save it, because GitHub gives `issues` runs and `workflow_run` runs from forks read-only cache access, so the next sweep checks the items that event runs triaged once more. Every run joins one job-level `concurrency` group with `queue: max`, so a burst of runs waits its turn instead of being cancelled.

## Job summary and run summary

Once its configuration checks out, every run writes a job summary to its page on GitHub. It shows:

- the mode, the model, the policy file (or the built-in policy) and the README, with the commit they were read at, and the prompt hash;
- for a `workflow_run` event, the pull request it led to and how AutoTriage found it, such as `PR #12 (fork lookup by pat:fix-typo, head SHA matched)`;
- a notice when the event had nothing to triage, and why;
- the items the run acted on, or would have in a dry run, with their operations;
- the labels the model planned that the repository doesn't have or has archived, which were dropped from the plan;
- each failed or deferred item, and any items an early stop left out, with the reason;
- the item counts, how many items a sweep left for the next sweep, and the model's token counts.

Each failed or deferred item also gets a warning annotation. GitHub shows up to 10 warnings per step, so any more are merged into one.

**When the job fails.** A run fails only when something needs fixing:

- a configuration error at startup, such as a missing token or key, an invalid or removed input, or a blank `model` with several keys set;
- a model error that every item would hit, such as a rejected API key, an unknown model, or an account out of credit;
- a GitHub error that means the token or the workflow's permissions are wrong: HTTP 401, a 403 that isn't a rate limit, or a 404 for the listing of the repository's files, which is how a private repository answers a token without `contents: read`;
- an unexpected error, which points to a bug in AutoTriage.

Everything else only warns, so a provider's bad day doesn't turn your runs red. That covers model overloads, rate limits and timeouts, replies that are malformed, refused or cut off, deferred items, GitHub outages, rate limits and network errors, including one that stops the run before it can read the policy, and a run that stops after three items in a row fail. An event with nothing to triage ends the run green with a notice.

**Run summary.** Each run writes a machine-readable `run-summary.json` to the `artifacts/` directory, alongside the system prompt (`prompt-system.md`) and the per-issue prompts and analyses, which the example uploads. It mirrors the `📊 Run Statistics` log, so runs can be aggregated across history rather than scraped from logs. Its `schemaVersion` is 5. It includes:

- `model` — the model ID the run sent.
- `config` / `promptHash` — the run's effective settings and a truncated hash of the assembled system prompt, so runs can be segmented by configuration and policy version.
- `github` — the number of GitHub API calls the run made.
- `funnel` — items discovered and processed; how many processed items were `triaged`, `deferred` (the item changed during its final analysis, or couldn't be rechecked, so its plan wasn't applied) or `failed`; and how many items a sweep left for the next sweep (`leftForNextSweep`). The three outcome counts add up to `processed`.
- `usage` — the number of model calls, their duration percentiles and their token usage, including `cachedInputTokens` and `reasoningTokens` (the reasoning tokens a provider reports, which output tokens exclude here).
- `items` — per-item rows with outcome, whether the item changed during analysis and was analyzed again (`reanalyzed`, where the row describes the second analysis and its `usage` covers both), what the model planned (`plan`: the operation kinds and signed label changes such as `+bug`), the item's model time and tokens (`usage`), the operations performed, and for failures, why (`failureReason`: `capacity`, `retryable`, `permanent` or `fatal` for a model error, or `other` for an error outside the model call).

## Models

AutoTriage talks to every provider through its OpenAI-compatible Chat Completions API: Gemini's OpenAI-compatible API, Claude's OpenAI SDK compatibility API, or OpenAI. [Step 1](#1-add-an-api-key) lists each key's default model.

- With one key set, every model goes to it, and a blank `model` uses its default.
- With several keys set, a `gemini-*` or `claude-*` model goes to Gemini or Claude when that key is set, and any other model goes to OpenAI or `OPENAI_BASE_URL`. A blank `model` with several keys set fails the run as a configuration error, so set `model` or map only one key. `OPENAI_BASE_URL` counts as a key here.
- The log names the model, host and reasoning setting, such as `Model: gpt-6-luna at api.openai.com (default for OPENAI_API_KEY), reasoning: high.` For Claude it says `reasoning: provider default (api.anthropic.com ignores reasoning_effort)`, and where a provider reports no reasoning tokens, the log says `reasoning not reported`.

**Any OpenAI-compatible service** (OpenRouter, Azure OpenAI, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Cerebras, LiteLLM, vLLM, Ollama, ...) works by setting `OPENAI_BASE_URL` to its API base, such as `https://openrouter.ai/api/v1`, and `model` to a model it serves, because there's no default. For Azure OpenAI, use `https://<resource>.openai.azure.com/openai/v1` and your deployment name as the model. `OPENAI_API_KEY` is optional for a local server such as Ollama on a self-hosted runner. `OPENAI_BASE_URL` must use https (plain http is allowed only for localhost) and can't include a user name or password, and redirects aren't followed.

**What each call asks for.** Every plan is requested as strict JSON that matches the plan schema, with `reasoning_effort: high`. A service that rejects either setting by name gets requests without it for the rest of the run. OpenAI and Gemini enforce the schema. Anywhere else, the schema is also written into the prompt. A reply that isn't a JSON plan is retried, and operations that don't fit the schema are dropped. Claude's compatibility API ignores both settings, so Claude follows the schema from the prompt and thinks at its default effort, and Anthropic describes that API as meant for evaluation rather than production.

**After switching providers**, review the plans of a few manual dry runs before relying on it, because the actions are only as good as the model's instruction-following.

**Your data.** Issue and pull request text goes to the provider you pick. Gateways such as OpenRouter forward the text to further providers. Token counts in the run summary follow each provider's own counting, so they aren't comparable across providers.

## Security

- **No checkout.** AutoTriage reads your policy and README through the GitHub API and runs no code from your repository, so the workflow has no checkout step, and no pull request's code runs with your secrets or write token.
- **The policy is read at the event's commit** (`GITHUB_SHA`), so under every event except `pull_request`, a pull request can't change the policy that triages it:
  - `issues`, `issue_comment`, `schedule` and `workflow_run`: the head of the default branch.
  - `workflow_dispatch`: the head of the branch you run it from, which is the default branch unless you pick another.
  - `pull_request_target`: the head of the pull request's base branch, usually the default branch.
  - `pull_request`: the pull request's merge commit, so its own copy of the policy applies. This repository's CI uses that on purpose, to dry-run a pull request's policy edits. It's safe because GitHub gives `pull_request` runs from forks no secrets and a read-only token.
  - A local run, which has no `GITHUB_SHA`: the default branch.
- **The policy and README are named in the log and the job summary**, such as `Policy: .github/AutoTriage.prompt at 1a2b3c4` or `Policy: built-in`, and `README: README.md at 1a2b3c4` or `README: none`. The README is the root file named README in any case, with no extension or `.md`, `.markdown` or `.txt`. AutoTriage first lists the repository's root files, and if GitHub refuses, the token can't read the repository's contents, so the run fails and asks for `contents: read`. A GitHub outage or rate limit while reading either file stops the run with a warning, rather than triaging with the built-in policy in place of yours.
- **`workflow_run` runs from the default branch.** GitHub runs `autotriage.yml` as it is on the default branch, whatever a pull request changes. A fork controls only its own copy of `autotriage-pr.yml`, so AutoTriage trusts nothing the signal run produces, such as its outputs, artifacts or title. The 10-minute window bounds how many runs a fork can cause by making its copy fire on every push.
- **Item text is data, not instructions.** The system prompt tells the model so, and only a clause of your policy can allow an operation. The built-in policy only adds labels the repository already has.

## Migrating from v4

Don't merge a Renovate or Dependabot pull request that bumps `@v4` to `@v5` as it is. Every removed input fails the first run as a configuration error, so update the workflow by hand, or edit that pull request before merging it.

| v4 | v5 |
| --- | --- |
| `model-pro` | Rename it to `model`. |
| `model-fast` | Delete it. Every item gets one review with `model`. |
| `max-fast-runs`, `max-pro-runs` | Delete them. Sweeps stop at 30 items, and explicit `issues` lists run in full. |
| `extended` | Delete it. With a policy file, sweeps revisit unchanged and recently closed items. |
| `budget-scale` | Delete it. |
| `additional-instructions` | Move the text into `.github/AutoTriage.prompt`. |
| `prompt-path` | Delete it. The policy is always `.github/AutoTriage.prompt`, read through the API at the event's commit. |
| `db-path` | Delete it. The triage history is always `triage-db.json` in the working directory, so cache that path. |
| `strict-mode` | Delete it. Runs fail only for configuration errors and bugs. |
| `actions/checkout` step | Delete it, unless another step needs it. |
| `pull_request_target` | Use the two files from [step 2](#2-add-the-two-workflow-files), or keep it with an Actions event policy, scoped to that workflow, that allows every event it uses. Private repositories aren't affected. |
| More than one API key mapped | Map only the key you use. A blank `model` with several keys set fails the run. |
| An `issue_comment` workflow | Optional. It still works, but sweeps already pick up items with new comments. |
| Another event that names no item, such as `push` | It no longer sweeps the backlog. Only `schedule` and `workflow_dispatch` do. |
| `artifacts/0-run-summary.json` | `artifacts/run-summary.json`, with `schemaVersion` 5. |
