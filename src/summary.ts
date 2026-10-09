import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from './config';
import { describeEndpoint } from './llm/endpoint';
import type { ItemRecord, RunStatistics } from './stats';
import { errorMessage } from './util';

// GitHub shows at most 10 warning annotations per step and drops the rest.
const WARNING_LIMIT = 10;
// A provider's error body can run to a couple of thousand characters, so reasons are cut short.
const REASON_CHARS = 300;
// Past this many, the items a run didn't reach are counted rather than linked.
const LINKED_NOT_REACHED = 50;

// What the run knows beyond its statistics.
export interface RunReport {
  // The policy file, or null when the built-in label-only policy stood in for a missing one.
  policy: string | null;
  // The targets the run stopped before, and why.
  notReached?: { items: number[]; reason: string } | undefined;
  // Each failure has already failed the job, and each warning has already been annotated.
  failures: string[];
  warnings: string[];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function unfinished(items: ItemRecord[]): ItemRecord[] {
  return items.filter((item) => item.outcome === 'failed' || item.outcome === 'deferred');
}

function describeOutcome(item: ItemRecord): string {
  if (item.outcome === 'deferred') return 'Deferred';
  return item.failedPass ? `Failed (${item.failedPass === 'fast' ? 'fast' : 'review'} pass)` : 'Failed';
}

function reasonFor(item: ItemRecord): string {
  return truncate(item.detail ?? item.failureReason ?? 'No reason was recorded.', REASON_CHARS);
}

/**
 * Warns once for each failed or deferred item, after the run's own warnings.
 * Whatever wouldn't fit under GitHub's limit is merged into one last warning.
 */
export function annotateItems(items: ItemRecord[], runWarnings: number): void {
  const problems = unfinished(items);
  const slots = Math.max(1, WARNING_LIMIT - runWarnings);
  const shown = problems.length > slots ? problems.slice(0, slots - 1) : problems;
  for (const item of shown) {
    core.warning(`#${item.issueNumber} ${describeOutcome(item).toLowerCase()}: ${reasonFor(item)}`);
  }
  const rest = problems.slice(shown.length);
  if (rest.length > 0) {
    core.warning(`${rest.length} more items failed or were deferred: ${rest.map((item) => `#${item.issueNumber}`).join(', ')}. The job summary says why.`);
  }
}

/**
 * Writes the run's job summary, which GitHub shows on the run's page.
 * Everything taken from the repository or a provider, such as titles and error text, is escaped.
 */
export async function writeJobSummary(
  cfg: Pick<Config, 'owner' | 'repo' | 'dryRun' | 'models'>,
  stats: RunStatistics,
  report: RunReport
): Promise<void> {
  // A local run has no job summary to write to.
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const run = stats.toJSON();
  const items = stats.getItems();
  const types = new Map(items.map((item) => [item.issueNumber, item.type]));
  const titles = new Map(items.map((item) => [item.issueNumber, item.title]));
  const repoUrl = `${github.context.serverUrl}/${cfg.owner}/${cfg.repo}`;
  const link = (n: number) => `<a href="${repoUrl}/${types.get(n) === 'pull request' ? 'pull' : 'issues'}/${n}">#${n}</a>`;
  const code = (text: string) => `<code>${escapeHtml(text)}</code>`;
  const header = (...names: string[]) => names.map((data) => ({ data, header: true }));
  const summary = core.summary.emptyBuffer().addHeading('AutoTriage', 2);
  const paragraph = (html: string) => summary.addRaw(`<p>${html}</p>`, true);

  summary.addList([
    `Mode: ${cfg.dryRun ? 'dry run, so nothing was changed' : 'live'}`,
    `Fast pass: ${cfg.models.fast ? code(describeEndpoint(cfg.models.fast)) : 'skipped'}`,
    `Review pass: ${code(describeEndpoint(cfg.models.pro))}`,
    `Policy: ${report.policy ? code(report.policy) : 'the built-in label-only policy, because no policy file was found'}`,
    ...(run.promptHash
      ? [`Prompt hashes: ${run.promptHash.fast ? `fast ${code(run.promptHash.fast)}, ` : ''}review ${code(run.promptHash.pro)}`]
      : []),
  ]);
  for (const message of report.failures) paragraph(`❌ ${escapeHtml(message)}`);
  for (const message of report.warnings) paragraph(`⚠️ ${escapeHtml(message)}`);

  const actions = [...stats.getActionDetails()].sort(([a], [b]) => a - b);
  if (actions.length > 0) {
    summary.addHeading(cfg.dryRun ? 'Planned' : 'Acted on', 3).addTable([
      header('Item', 'Title', 'Operations'),
      ...actions.map(([n, details]) => [link(n), escapeHtml(titles.get(n) ?? ''), escapeHtml(details.join(', '))]),
    ]);
  }

  const problems = unfinished(items);
  const notReached = report.notReached?.items ?? [];
  if (problems.length > 0 || notReached.length > 0) {
    summary.addHeading('Not finished', 3);
    if (problems.length > 0) {
      summary.addTable([
        header('Item', 'Outcome', 'Reason'),
        ...problems.map((item) => [link(item.issueNumber), describeOutcome(item), escapeHtml(reasonFor(item))]),
      ]);
    }
    if (report.notReached && notReached.length > 0) {
      const linked = notReached.slice(0, LINKED_NOT_REACHED).map(link).join(', ');
      const more = notReached.length > LINKED_NOT_REACHED ? ` and ${notReached.length - LINKED_NOT_REACHED} more` : '';
      paragraph(`⏳ Not reached because ${escapeHtml(report.notReached.reason)}: ${linked}${more}.`);
    }
  }

  const { discovered, processed, triaged, skipped, deferred, failed, escalatedToPro } = run.funnel;
  summary.addHeading('Counts', 3);
  paragraph(`Discovered ${discovered} and processed ${processed}: ${triaged} triaged, ${skipped} skipped by the fast pass, ${deferred} deferred and ${failed} failed. ${escalatedToPro} reached the review pass.`);
  const passes = ([['Fast', run.fast], ['Review', run.pro]] as const).filter(([, usage]) => usage.runs > 0);
  if (passes.length > 0) {
    const count = (n: number) => n.toLocaleString('en-US');
    summary.addTable([
      header('Pass', 'Model calls', 'Input tokens', 'Cached input', 'Output tokens', 'Reasoning tokens'),
      ...passes.map(([pass, usage]) => [pass, count(usage.runs), count(usage.inputTokens), count(usage.cachedInputTokens), count(usage.outputTokens), count(usage.reasoningTokens)]),
    ]);
  }

  try {
    await summary.write();
  } catch (err) {
    summary.emptyBuffer();
    console.warn(`⚠️ Failed to write the job summary: ${errorMessage(err)}`);
  }
}
