# AutoTriage

Keep issues and pull requests moving: reads the latest context, drafts the next move, and applies it with the rules you define in your prompt.

## How it works

- The run starts with a fast AI pass to gather signals, summarize the thread, and draft the intended operations.
- A reviewing AI pass (default: `gemini-3-flash-preview`) replays the plan and confirms labels, comments, etc, before anything is written.
- Defaults use the free-tier models (`gemini-2.5-flash` + `gemini-3-flash-preview`) rather than `gemini-3-pro`.
- The full thought process along with all actions can be inspected in the workflow artifacts.
- It will keep going until it runs out of issues or tokens, or reaches the specified limit.

## Quick setup

1. Copy the [default prompt](./examples/AutoTriage.prompt) into your repo as `.github/AutoTriage.prompt` and tailor the labeling rules or tone.
2. Add a `GEMINI_API_KEY` secret to your repository (or organization) pointing at your AI provider key.
3. Drop a dry-run workflow such as:

```yaml
name: nightly-auto-triage
on:
  schedule:
    - cron: "0 0 * * *"
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: AutoTriage
        uses: danielchalmers/AutoTriage@main
        with:
          enabled: false # flip to true once you're comfortable with the plan output
```

4. Review the artifacts, then set `enabled: true` when you are ready.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `issue-number` | Triage a single issue or PR; falls back to the GitHub event target. | event target |
| `issue-numbers` | Provide an explicit list (space or comma separated). | - |
| `prompt-path` | Path to the triage prompt file you control. | `.github/AutoTriage.prompt` |
| `readme-path` | Extra Markdown context uploaded to the AI prompt. | `README.md` |
| `enabled` | `"true"` applies changes, `"false"` logs the plan only. | `"true"` |
| `db-path` | Persist per-item history between runs. | - |
| `model-fast` | Fast analysis model for the first pass. Leave blank to skip. | `gemini-2.5-flash` |
| `model-pro` | Review model that double-checks uncertain plans. | `gemini-3-flash-preview` |
| `model-fast-temperature` | Sampling temperature for fast model (`0` deterministic -> `2` exploratory). | `0.0` |
| `model-pro-temperature` | Sampling temperature for pro model (`0` deterministic -> `2` exploratory). Gemini 3 recommends `1.0`. | `1.0` |
| `budget-scale` | Scales all internal Fast/Pro context limits (`1` = defaults, `2` ≈ double). | `1` |
| `max-triages` | Cap on items that escalate to the review pass per run. | `20` |
| `max-fast-runs` | Cap on items analyzed with the fast model per run. | `100` |
| `additional-instructions` | Additional instructions appended to the prompt for testing or tweaking behavior without committing a new prompt. | - |
| `context-caching` | Enable Gemini context caching (disabled by default). | `"false"` |
| `skip-unchanged` | Skip re-processing issues already in the database that haven't changed since the last run. | `"false"` |
| `strict-mode` | Fail the overall job if any individual run errors occur. | `"false"` |

## Example Workflows

See ready-to-use workflow files in [`examples/workflows`](./examples/workflows/):

- [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) – run on issue events.
- [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) – run on pull request events.
- [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) – scheduled/backlog sweep.

Copy one into `.github/workflows/` and adjust `enabled`, schedules, or permissions as needed.

## Example

[MudBlazor](https://github.com/MudBlazor/MudBlazor) is a popular UI library that uses AutoTriage for all new issues, PRs, and comments.

Here's what a typical thought process looks like:

> 💭 Thinking with gemini-2.5-pro...
> 
> Okay, so I've got a pull request to triage. Let's break this down. Firstly, the PR itself looks straightforward. It's titled "Docs: Update cookie consent prompt design," so immediately I'm thinking documentation updates, which is nice and specific. The author is `danielchalmers`, and the good news is they are a maintainer. That's a good sign – they're likely familiar with the project's standards and processes. The body describes visual changes to the cookie consent prompt and includes before/after screenshots, which is really helpful. Now, let's consult the ASSISTANT BEHAVIOR POLICY. This is where I can ensure I'm following the established guidelines. Since the author is a maintainer, I can skip sections related to encouraging contributions, triaging, and addressing missing information. I also don't need to worry about title edits or inactivity rules. The policy is really tailored to this scenario! The main thing I need to focus on is labeling. The title starts with "Docs:", which is a clear indicator, and the changes are specifically about the documentation site. Although the changes involve visual improvements, and could be interpreted as an `enhancement` or `refactor`, the "Docs" prefix makes the `docs` label the most appropriate, as it's directly tied to the documentation site. Finally, I can synthesize my actions. The summary will be: "A maintainer submitted a pull request to update the visual design of the cookie consent prompt on the documentation website." The label will be `docs`. No comments or state changes are needed. The title is fine as it is.
> 
> 🏷️ Labels: +docs

See MudBlazor's [workflows](https://github.com/MudBlazor/MudBlazor/actions) to browse artifacts, or view the [actual prompt](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## License

MIT
