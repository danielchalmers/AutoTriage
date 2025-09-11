# AutoTriage

AI-assisted triage for GitHub Issues & Pull Requests. AutoTriage summarizes items, applies / removes labels, posts comments, suggests better titles, and can optionally change issue state. It is driven by a project-specific prompt plus two Gemini model passes (fast first, then a higher quality review only if needed). A lightweight JSON DB (optional) preserves cumulative reasoning so model decisions stay explainable and append-only.

## Key Features

* Two-stage analysis (fast pass, conditional review pass) to save tokens.
* Deterministic prompt template you fully control (checked into your repo).
* Cumulative reasoning log: every run appends instead of overwriting context.
* Dry-run mode for safe experimentation (no writes).
* Explicit op budget (max operations) to keep runs predictable.
* Artifacts (prompt + model raw output + planned operations) for debugging.

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `issue-number` | Single issue or PR number to triage (defaults to event context). | - |
| `issue-numbers` | Space or comma separated list of issue/PR numbers to triage explicitly. | - |
| `prompt-path` | Repo-relative path to the prompt template. | `.github/AutoTriage.prompt` |
| `enabled` | `true` = apply changes, `false` = dry-run only. | `true` |
| `db-path` | Optional JSON file storing per-issue summary + reasoning history. | - |
| `model-fast` | Gemini model for the first (fast) pass. | `gemini-2.5-flash` |
| `model-pro` | Gemini model for the second (review) pass. | `gemini-2.5-pro` |
| `model-temperature` | Sampling temperature (0-2). Lower = more deterministic. | `1.0` |
| `max-timeline-events` | Max most-recent timeline events included in prompt. | `50` |
| `max-operations` | Cap on actions (label/comment/title/state) per run. | `10` |

## Required Secrets

| Secret | Purpose |
|--------|---------|
| `GITHUB_TOKEN` | Standard Actions token (provided automatically in most workflows). |
| `GEMINI_API_KEY` | API key for Google Gemini models. |

## Prompt Template

Create a project prompt (default path: `.github/AutoTriage.prompt`). Keep: rules, labeling conventions, closure criteria, tone for comments, title style guidelines. The action injects issue body, metadata, timeline, prior reasoning, and a strict JSON output schema section.

## Example Workflows

See ready-to-use workflow files in [`examples/workflows`](./examples/workflows/):

* [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) – run on issue events.
* [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) – run on pull request events.
* [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) – scheduled/backlog sweep.

Copy one into `.github/workflows/` and adjust `enabled`, schedules, or permissions as needed.

## Targeting Specific Issues

To triage specific items manually (e.g. via a workflow_dispatch input or a one-off run), set `issue-numbers` or `issue-number` in the job step `with:` block. Spaces or commas are both accepted, e.g. `issue-numbers: "123 456,789"`. Combine with `enabled: "false"` for a safe dry-run.

## Dry-Run Mode

Set `enabled: "false"` to log planned operations with an `🧪 [dry-run]` prefix. No labels, comments, titles, or closures are changed.

## Reasoning History

If `db-path` is provided and `enabled` is true, each run appends to the reasoning log + maintains a canonical summary. This powers duplicate detection or clustering later (out of scope here, but data is retained).

## Artifacts

For each item the action writes (in `./artifacts`):

* `ISSUEID-gemini-input-<model>.md` - exact prompt sent to the model.
* `ISSUEID-gemini-output-<model>.json` - raw Gemini response.
* `ISSUEID-analysis-<model>.json` - parsed structured analysis.
* `ISSUEID-operations.json` - final planned ops.

## License

MIT
