import * as github from '@actions/github';
import type { GitHubClient, PullRequestSummary } from './github';
import { parseTimestamp } from './util';

// The event that started the run. A local run has no event name.
export interface TriggerEvent {
  name: string | undefined;
  payload: unknown;
}

// What the event asks the run to triage: one item, a backlog sweep, or nothing, with a notice that says why.
// via says how the pull request behind a workflow_run event was found.
export type EventTarget =
  | { kind: 'item'; number: number; via?: string }
  | { kind: 'sweep' }
  | { kind: 'none'; notice: string };

export type EventGitHub = Pick<GitHubClient, 'getPullRequest' | 'listOpenPullRequestsByHead' | 'getLastReadyForReview'>;

/**
 * A workflow_run event triages its pull request only if the trigger run was created no more than 1 minute before and no more than 10 minutes after the pull request was opened or last marked ready for review.
 * This bounds what a fork can cost by editing its copy of the trigger workflow to fire on every push.
 * A run's created_at is when its event happened, so a wait for a maintainer to approve the run doesn't count against it.
 */
export const TRIGGER_RECENCY_WINDOW = { beforeMs: 60 * 1000, afterMs: 10 * 60 * 1000 };

// Only these events sweep the backlog. A blank event name means a local run.
const SWEEP_EVENTS = new Set(['schedule', 'workflow_dispatch']);
// The events a workflow_run's trigger run can have for AutoTriage to find a pull request behind it.
const PULL_REQUEST_EVENTS = new Set(['pull_request', 'pull_request_target']);

export function currentEvent(): TriggerEvent {
  return { name: github.context.eventName || undefined, payload: github.context.payload };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asItemNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function minutes(ms: number): string {
  const count = ms / 60_000;
  return `${count} minute${count === 1 ? '' : 's'}`;
}

/**
 * Resolves what the event asks the run to triage, after an explicit issues input has been ruled out.
 * An event whose payload names an issue or pull request triages it, a workflow_run event triages the pull request behind its run, and only schedule, workflow_dispatch and local runs sweep the backlog.
 */
export async function resolveEventTarget(event: TriggerEvent, gh: EventGitHub): Promise<EventTarget> {
  const payload = asRecord(event.payload) ?? {};
  const named = asItemNumber(asRecord(payload.issue)?.number) ?? asItemNumber(asRecord(payload.pull_request)?.number);
  if (named !== undefined) return { kind: 'item', number: named };
  if (event.name === 'workflow_run') return resolveWorkflowRun(payload, gh);
  if (!event.name || SWEEP_EVENTS.has(event.name)) return { kind: 'sweep' };
  return { kind: 'none', notice: `Nothing to triage for the ${event.name} event, because it names no issue or pull request and only schedule and workflow_dispatch events sweep the backlog.` };
}

/**
 * Finds the pull request behind a workflow_run event from fields GitHub sets.
 * The trigger run's outputs, artifacts and display title are never read, because a fork controls its copy of the trigger workflow.
 */
async function resolveWorkflowRun(payload: Record<string, unknown>, gh: EventGitHub): Promise<EventTarget> {
  const none = (notice: string): EventTarget => ({ kind: 'none', notice });
  const run = asRecord(payload.workflow_run) ?? {};
  const runEvent = asText(run.event);
  if (!runEvent || !PULL_REQUEST_EVENTS.has(runEvent)) {
    return none(`Nothing to triage for the workflow_run event, because the run it reports was triggered by ${runEvent ?? 'an unknown event'}, not by a pull request.`);
  }
  const runCreatedAt = asText(run.created_at);
  const runCreatedMs = parseTimestamp(runCreatedAt);
  if (!runCreatedMs) {
    return none("Nothing to triage for the workflow_run event, because the run it reports has no creation time to check against the pull request's.");
  }

  const found = await findPullRequest(payload, run, gh);
  if ('notice' in found) return none(found.notice);
  const { pr, via } = found;
  if (pr.state !== 'open') return none(`PR #${pr.number} is closed, so the workflow_run event has nothing to triage.`);
  if (pr.draft) return none(`PR #${pr.number} is a draft, so the workflow_run event has nothing to triage.`);

  // The pull request's own creation time settles most runs, so its timeline is read only when that doesn't.
  const inWindow = (at: string | undefined) => {
    const ms = parseTimestamp(at);
    return ms > 0 && runCreatedMs >= ms - TRIGGER_RECENCY_WINDOW.beforeMs && runCreatedMs <= ms + TRIGGER_RECENCY_WINDOW.afterMs;
  };
  if (!inWindow(pr.created_at) && !inWindow(await gh.getLastReadyForReview(pr.number))) {
    return none(`PR #${pr.number} isn't triaged, because the workflow run was created at ${runCreatedAt}, which isn't between ${minutes(TRIGGER_RECENCY_WINDOW.beforeMs)} before and ${minutes(TRIGGER_RECENCY_WINDOW.afterMs)} after the PR was opened or last marked ready for review.`);
  }
  return { kind: 'item', number: pr.number, via: `PR #${pr.number} (${via})` };
}

async function findPullRequest(
  payload: Record<string, unknown>,
  run: Record<string, unknown>,
  gh: EventGitHub
): Promise<{ pr: PullRequestSummary; via: string } | { notice: string }> {
  // A same-repository pull request is listed on the run. A fork's pull request isn't, and the list can name pull requests in other repositories.
  const repositoryId = asRecord(payload.repository)?.id;
  const listed = (Array.isArray(run.pull_requests) ? run.pull_requests : [])
    .map(asRecord)
    .find((entry) => typeof repositoryId === 'number' && asRecord(asRecord(entry?.base)?.repo)?.id === repositoryId);
  const listedNumber = asItemNumber(listed?.number);
  if (listedNumber !== undefined) {
    return { pr: await gh.getPullRequest(listedNumber), via: 'listed on the workflow run' };
  }

  // GitHub leaves head_repository null when the fork is gone.
  const headOwner = asText(asRecord(asRecord(run.head_repository)?.owner)?.login);
  const headBranch = asText(run.head_branch);
  if (!headOwner || !headBranch) {
    return { notice: "Nothing to triage for the workflow_run event, because the run it reports has no head repository or branch to find its pull request by." };
  }
  const head = `${headOwner}:${headBranch}`;
  const open = await gh.listOpenPullRequestsByHead(head);
  const headSha = asText(run.head_sha);
  const matched = open.find((pr) => pr.head_sha === headSha);
  if (matched) return { pr: matched, via: `fork lookup by ${head}, head SHA matched` };
  // A push right after opening moves the pull request's head past the run's, so a single match is still the one.
  if (open.length === 1) return { pr: open[0]!, via: `fork lookup by ${head}, the only open match` };
  return {
    notice: open.length === 0
      ? `No open pull request comes from ${head}, so the workflow_run event has nothing to triage.`
      : `${open.length} open pull requests come from ${head} and none has the run's head SHA, so the workflow_run event has nothing to triage.`,
  };
}
