import { ModelError, errorMessage } from './llm/chat';

/**
 * How a failure bears on the job.
 * A configuration error would hit every later item too, so it stops the run and fails the job.
 * A bug fails the job, because only a fix to AutoTriage helps.
 * An external failure, such as an overloaded model or a GitHub outage, only warns, so someone else's bad day doesn't turn the run red.
 */
export type FailureClass = 'configuration' | 'bug' | 'external';

// Network failures that reach the runner without Octokit's wrapper, which reports its own as HTTP 500.
const NETWORK_ERROR = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)$/;

type GitHubError = Error & { status: number; response?: { headers?: Record<string, unknown> } };

// Octokit's RequestError, recognized by its name and status so the action doesn't depend on @octokit/request-error directly.
function asGitHubError(err: unknown): GitHubError | undefined {
  return err instanceof Error && err.name === 'HttpError' && typeof (err as Partial<GitHubError>).status === 'number'
    ? err as GitHubError
    : undefined;
}

function hasNetworkCode(err: unknown): boolean {
  const cause = err instanceof Error && 'cause' in err ? err.cause : undefined;
  return [err, cause].some(e => {
    const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
    return typeof code === 'string' && NETWORK_ERROR.test(code);
  });
}

export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof ModelError) return err.kind === 'fatal' ? 'configuration' : 'external';
  const github = asGitHubError(err);
  if (github) {
    // GitHub also answers a rate limit with a 403. Any other 401 or 403 means the token or the workflow's permissions are wrong.
    const rateLimited = github.response?.headers?.['x-ratelimit-remaining'] === '0' || /rate limit/i.test(github.message);
    return github.status === 401 || (github.status === 403 && !rateLimited) ? 'configuration' : 'external';
  }
  return hasNetworkCode(err) ? 'external' : 'bug';
}

// One line on what went wrong, for the log, the job summary and the item's warning.
export function describeFailure(err: unknown): string {
  const github = asGitHubError(err);
  const text = github
    ? `${github.response ? `GitHub returned HTTP ${github.status}` : 'The GitHub request failed'}: ${errorMessage(err)}`
    : classifyFailure(err) === 'bug'
      ? `Unexpected ${err instanceof Error ? err.name : 'error'}: ${errorMessage(err)}`
      : errorMessage(err);
  return text.replace(/\s+/g, ' ').trim();
}

// What to fix for a configuration error. A model error already names the key or setting to check.
export function configurationHint(err: unknown): string {
  const status = asGitHubError(err)?.status;
  if (status === 401) return ' Check the token in GITHUB_TOKEN.';
  if (status === 403) return ' Check that the token can reach this repository and that the workflow\'s permissions grant contents: read, issues: write and pull-requests: write.';
  return '';
}
