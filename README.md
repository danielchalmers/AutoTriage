# AutoTriage

Keep issues and pull requests moving: reads the latest context, drafts the next move, and applies it with the rules you define in your prompt.

## How it works

- The run starts with a fast AI pass to gather signals, summarize the thread, and draft the intended operations.
- If confidence is low, a reviewing AI pass (default: `gemini-2.5-pro`) replays the plan, catches edge cases, and confirms labels, comments, or closures before anything is written.
- The full thought process along with all actions can be inspected in the workflow artifacts.
- Safeguards pause the run after three failed analyses in a row and keep unlimited sweeps bounded by the same guard.

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
| `model-fast` | Fast analysis model for the first pass. | bundled fast model |
| `model-pro` | Review model that double-checks uncertain plans. | bundled review model |
| `model-temperature` | Sampling temperature (`0` deterministic -> `2` exploratory). | `0.0` |
| `max-timeline-events` | Maximum recent timeline events included in the prompt. | `50` |
| `max-triages` | Cap on items that escalate to the review pass per run. | `20` |

## Example Workflows

See ready-to-use workflow files in [`examples/workflows`](./examples/workflows/):

- [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) – run on issue events.
- [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) – run on pull request events.
- [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) – scheduled/backlog sweep.

Copy one into `.github/workflows/` and adjust `enabled`, schedules, or permissions as needed.

## Targeting Specific Issues

To triage specific items manually (e.g. via a workflow_dispatch input or a one-off run), set `issue-numbers` or `issue-number` in the job step `with:` block. Spaces or commas are both accepted, e.g. `issue-numbers: "123 456,789"`. Combine with `enabled: "false"` for a safe dry-run.

## License

MIT
