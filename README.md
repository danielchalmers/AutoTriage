# AutoTriage

Lean AI triage for GitHub Issues & PRs (labels, info requests, title cleanup, optional closure) powered by a project prompt + Gemini.

## 1. What It Does

AutoTriage reads a configurable policy prompt, injects issue/PR context (body, metadata, recent timeline, prior reasoning), then:

* Suggests & applies existing repository labels (never creates new ones)
* Posts a single clarifying comment when information is missing
* Optionally rewrites unclear/misleading titles
* Optionally closes issues when policy criteria are explicitly met
* Maintains a lightweight JSON DB (summary + cumulative reasoning history) for duplicate detection and consistency

Two-pass safety: fast model first; if it proposes actions (or fails), a review (pro) model re-evaluates before anything is written.

## 2. Quick Start

Use the examples below as starting points:

Examples directory: `examples/`

* Minimal policy prompt: `examples/AutoTriage.prompt`
* Issue workflow: `examples/workflows/autotriage-issues.yml`
* PR workflow: `examples/workflows/autotriage-prs.yml`
* Backlog batch/schedule: `examples/workflows/autotriage-backlog.yml`

Recommended prompt location (default): `.github/AutoTriage.prompt`

Required secrets:

* `GEMINI_API_KEY`
* `GITHUB_TOKEN` (provided automatically, just set permissions)

Minimum workflow permissions:

```yaml
permissions:
  contents: read
  issues: write
```
Add `pull-requests: write` only if you later extend behavior beyond Issues API basics.

## 3. Inputs

| Input | Default | Purpose |
|-------|---------|---------|
| `issue-number` | (event) | Single issue/PR number override. |
| `issue-numbers` |  | Space/comma list for batch runs. |
| `prompt-path` | `.github/AutoTriage.prompt` | Project policy prompt path. |
| `enabled` | `true` | If `false`, dry-run (logs only, no writes). |
| `db-path` |  | JSON file to persist summary, reasoning history, last triaged timestamp. |
| `model-fast` | `gemini-2.5-flash` | First-pass model. |
| `model-pro` | `gemini-2.5-pro` | Review model. |
| `model-temperature` | `1.0` | Sampling temperature (string). |
| `max-timeline-events` | `50` | Recent timeline events injected into prompt. |
| `max-operations` | `10` | Hard cap on total write operations per run. |

## 4. Capabilities & Safeguards

| Capability | Details |
|------------|---------|
| Labeling | Filters to existing labels only; computes add/remove diff. |
| Commenting | At most one model-generated comment per run; embeds reasoning in an HTML comment footer. |
| Title edits | Only when clearly misleading/ambiguous AND improved title provided. |
| Closing | Only when prompt policy authorizes (e.g. invalid template, clearly obsolete, etc.). |
| Reasoning memory | Appends new reasoning to prior log (never truncates). |
| Operation budgeting | Stops after `max-operations` modifications. |
| Dry-run mode | `enabled: false` shows exactly what would happen (artifacts + logs). |

## 5. Authoring / Updating Your Prompt

File: `.github/AutoTriage.prompt` (or custom path via `prompt-path`).

Guidelines:

* Keep policy concise; the action appends large structured context automatically.
* Use HTML comments `<!-- ... -->` for maintainer notes the model should ignore.
* Define: labeling taxonomy, when to request info, closure rules, title hygiene rules, tone.
* Be explicit: “If X and Y then add label Z” > “Consider Z”.
* Avoid repeating output contract; the action injects a strict JSON schema.
* Iterate safely by running with `enabled: false` first and reviewing artifacts.

Suggested sections inside your prompt file:

```text
Core Behavior
Label Semantics
Missing Information Policy
Title Rules
Closure Rules
Contribution Labels (help wanted / good first issue)
Project Context (short, stable)
```

## 6. State & Artifacts

When `db-path` is set (e.g. `triage-db.json`), we persist:

* `summary` (canonical essence for de-duping)
* `reasoning` (full append-only chain)
* `lastTriaged`

Artifacts (always, per item) under `artifacts/`:

* `gemini-input-<model>.md` – full constructed prompt (each pass)
* `analysis-<model>.json` – raw model JSON output
* `operations.json` – planned operations (if any)

## 7. Typical Workflows

* Real-time issues: trigger on `issues` opened/edited.
* PR grooming: trigger on `pull_request` events (labels + info requests).
* Backlog sweep: scheduled + manual dispatch, pass `issue-numbers` or let it enumerate recent open items.
* Migration / auditing: run dry first to build summaries DB, then enable writes.

## 8. Local Development

```bash
npm install
npm run typecheck
npm run build
```
The bundle is emitted to `dist/` via `@vercel/ncc`.

## 9. Security & Permissions

* Uses the provided `GITHUB_TOKEN`; never stores secrets in artifacts.
* Only writes when `enabled: true`.
* Supply least privileges (no code checkout write needed beyond standard checkout + issues:write).

## 10. License

MIT

---
Need a starting point? Open `examples/AutoTriage.prompt` and adapt to your project in minutes.
