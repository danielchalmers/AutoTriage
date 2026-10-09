import * as github from '@actions/github';
import { describe, expect, it } from 'vitest';
import { classifyFailure, configurationHint, describeFailure } from '../src/failures';
import { ModelError } from '../src/llm/chat';
import { githubError } from './fixtures';

// The error a real Octokit call throws when GitHub answers with this status, or when fetch itself fails.
async function octokitError(response: Response | Error, headers: Record<string, string> = {}): Promise<unknown> {
  const fetch = async () => {
    if (response instanceof Error) throw response;
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
  const octokit = github.getOctokit('token', { request: { fetch } });
  return octokit.rest.issues.get({ owner: 'octo', repo: 'demo', issue_number: 1 }).then(
    () => { throw new Error('expected the request to fail'); },
    (err: unknown) => err
  );
}

function githubAnswer(status: number, message: string): Response {
  return Response.json({ message, documentation_url: 'https://docs.github.com/rest' }, { status });
}

describe('classifyFailure', () => {
  it.each([
    ['fatal', 'configuration'],
    ['capacity', 'external'],
    ['retryable', 'external'],
    ['permanent', 'external'],
  ] as const)('treats a %s model error as %s, and never as a bug', (kind, expected) => {
    expect(classifyFailure(new ModelError('api.openai.com returned an error', kind))).toBe(expected);
  });

  it.each([
    [401, 'Bad credentials', 'configuration'],
    [403, 'Resource not accessible by integration', 'configuration'],
    [404, 'Not Found', 'external'],
    [422, 'Validation Failed', 'external'],
    [429, 'Too Many Requests', 'external'],
    [500, 'Internal Server Error', 'external'],
    [502, 'Bad Gateway', 'external'],
    [503, 'Service Unavailable', 'external'],
  ])('treats a real Octokit HTTP %i (%s) as %s', async (status, message, expected) => {
    const err = await octokitError(githubAnswer(status, message));

    expect(classifyFailure(err)).toBe(expected);
    expect(describeFailure(err)).toBe(`GitHub returned HTTP ${status}: ${message} - https://docs.github.com/rest`);
  });

  it('treats a 403 for an exhausted rate limit as external', async () => {
    const err = await octokitError(githubAnswer(403, 'API rate limit exceeded for installation ID 1.'), { 'x-ratelimit-remaining': '0' });

    expect(classifyFailure(err)).toBe('external');
  });

  it('treats a 403 for a secondary rate limit as external', async () => {
    const err = await octokitError(githubAnswer(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'));

    expect(classifyFailure(err)).toBe('external');
  });

  it('treats a network failure under Octokit as external', async () => {
    const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const err = await octokitError(Object.assign(new TypeError('fetch failed'), { cause: socketError }));

    expect(classifyFailure(err)).toBe('external');
    expect(describeFailure(err)).toBe('The GitHub request failed: other side closed');
  });

  it('matches the RequestError shape the other tests fake', async () => {
    const real = await octokitError(githubAnswer(403, 'Resource not accessible by integration'));
    const fake = githubError(403, 'Resource not accessible by integration');

    expect(fake).toMatchObject({ name: (real as Error).name, status: 403, response: { status: 403 } });
  });

  it.each([
    ['on the error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['on its cause', Object.assign(new Error('request failed'), { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN api.github.com'), { code: 'EAI_AGAIN' }) })],
  ])('treats an error with a network code %s as external', (_where, err) => {
    expect(classifyFailure(err)).toBe('external');
  });

  it.each([
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'labels')"), "Unexpected TypeError: Cannot read properties of undefined (reading 'labels')"],
    ['a file system error', Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' }), 'Unexpected Error: EISDIR: illegal operation on a directory, read'],
    ['a thrown string', 'boom', 'Unexpected error: boom'],
  ])('treats %s as a bug', (_name, err, description) => {
    expect(classifyFailure(err)).toBe('bug');
    expect(describeFailure(err)).toBe(description);
  });
});

describe('describeFailure', () => {
  it('keeps a model error to one line', () => {
    expect(describeFailure(new ModelError('api.openai.com returned HTTP 500: {\n  "error": "boom"\n}'))).toBe('api.openai.com returned HTTP 500: { "error": "boom" }');
  });
});

describe('configurationHint', () => {
  it('names what to check for a rejected token or a missing permission', () => {
    expect(configurationHint(githubError(401, 'Bad credentials'))).toBe(' Check the token in GITHUB_TOKEN.');
    expect(configurationHint(githubError(403, 'Resource not accessible by integration'))).toContain('issues: write and pull-requests: write');
  });

  it('adds nothing to a model error, which names its own key or setting', () => {
    expect(configurationHint(new ModelError('api.openai.com returned HTTP 401: nope Check OPENAI_API_KEY.', 'fatal'))).toBe('');
  });
});
