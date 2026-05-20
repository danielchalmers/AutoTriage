# AutoTriage

AutoTriage is a GitHub Action for AI-assisted issue and pull request triage. It reads repository context, issue or pull request history, and a repository-defined prompt, then plans and applies authorized GitHub operations.

## Quick setup

1. Optional but recommended: copy the [default prompt](./examples/AutoTriage.prompt) into your repo as `.github/AutoTriage.prompt` and define your triage rules. If you skip this, AutoTriage falls back to a built-in label-only policy.
2. Add a `GEMINI_API_KEY` secret to your repository or organization.
3. Add a dry-run workflow:

```yaml
name: triage
on:
  schedule:
    - cron: "0 0 * * *"
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: AutoTriage
        uses: danielchalmers/AutoTriage@v4
        with:
          dry-run: "true" # change to "false" after reviewing the plan output
```

For event-specific workflows, start from the examples in [`examples/workflows`](./examples/workflows/):

- [`autotriage-issues.yml`](./examples/workflows/autotriage-issues.yml) - run on issue events.
- [`autotriage-prs.yml`](./examples/workflows/autotriage-prs.yml) - run on pull request events.
- [`autotriage-backlog.yml`](./examples/workflows/autotriage-backlog.yml) - scheduled backlog sweep.

## Inputs

| Name | Purpose | Default |
| --- | --- | --- |
| `additional-instructions` | Extra prompt instructions for this run. | - |
| `budget-scale` | Multiplier for prompt context limits. | `1` |
| `db-path` | Path to the triage history JSON file. | - |
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

## Example

[MudBlazor](https://github.com/MudBlazor/MudBlazor) uses AutoTriage for all new issues, PRs, and comments.

Here's what a typical thought process looks like:

> 💭 Thinking with gemini-3.1-flash-lite...
> 
> Okay, so I've got a pull request to triage. Let's break this down. Firstly, the PR itself looks straightforward. It's titled "Docs: Update cookie consent prompt design," so immediately I'm thinking documentation updates, which is nice and specific. The author is `danielchalmers`, and the good news is they are a maintainer. That's a good sign – they're likely familiar with the project's standards and processes. The body describes visual changes to the cookie consent prompt and includes before/after screenshots, which is really helpful. Now, let's consult the ASSISTANT BEHAVIOR POLICY. This is where I can ensure I'm following the established guidelines. Since the author is a maintainer, I can skip sections related to encouraging contributions, triaging, and addressing missing information. I also don't need to worry about title edits or inactivity rules. The policy is really tailored to this scenario! The main thing I need to focus on is labeling. The title starts with "Docs:", which is a clear indicator, and the changes are specifically about the documentation site. Although the changes involve visual improvements, and could be interpreted as an `enhancement` or `refactor`, the "Docs" prefix makes the `docs` label the most appropriate, as it's directly tied to the documentation site. Finally, I can synthesize my actions. The summary will be: "A maintainer submitted a pull request to update the visual design of the cookie consent prompt on the documentation website." The label will be `docs`. No comments or state changes are needed. The title is fine as it is.
> 
> 🏷️ Labels: +docs

See MudBlazor's [workflows](https://github.com/MudBlazor/MudBlazor/actions) to browse artifacts, or view the [actual prompt](https://github.com/MudBlazor/MudBlazor/blob/dev/.github/AutoTriage.prompt).

## License

[MIT](./LICENSE)
