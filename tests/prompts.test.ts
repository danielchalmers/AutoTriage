import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getOctokit: vi.fn() }));

vi.mock('@actions/github', () => ({ getOctokit: mocks.getOctokit }));

import { buildAnalysisResultSchema, buildSystemPrompt, buildUserPrompt, parseAnalysisResult, type FastPassPlan } from '../src/analysis';
import { GitHubClient, type Issue } from '../src/github';
import { buildRunContext } from '../src/issueProcessor';
import { ChatClient, type Fetch } from '../src/llm/chat';
import { explainPlan, planOperations } from '../src/triage';
import { makeConfig, withTempFiles } from './fixtures';

// These snapshots pin the exact text the models receive, so any change to it shows up in review as a diff of these files.
const snapshot = (name: string) => `./__snapshots__/prompts/${name}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const RUN_TIMESTAMP = '2026-10-01T06:00:00.000Z';
const LIMITS = makeConfig().limits;

// MudBlazor's 46 labels, as GitHub lists them.
const LABELS = [
  { name: 'accessibility', description: 'Accessibility concerns (ARIA, keyboard, focus, screen readers, contrast)' },
  { name: 'answered', description: 'A discussion has received a complete response' },
  { name: 'API change', description: 'Modifies the public API surface in a non-breaking way (ex: adds a new property)' },
  { name: 'awaiting triage', description: 'Needs maintainer review or assistance' },
  { name: 'blazor: hybrid', description: 'Only occurs with Blazor Hybrid apps (.NET MAUI, Electron, or other WebView-based hosts)' },
  { name: 'blazor: server', description: 'Only occurs with server hosting (SignalR/circuits, latency, pre-rendering)' },
  { name: 'blazor: wasm', description: 'Only occurs with WebAssembly hosting (AOT, trimming, size, sandbox)' },
  { name: 'breaking change', description: 'This change will require consumer code updates (ex: removes/changes an API)' },
  { name: 'browser: chromium', description: 'Reproducible only in Chrome, Edge, Opera, Vivaldi, Brave, or another Chromium/Blink browser' },
  { name: 'browser: firefox', description: 'Reproducible only in Firefox' },
  { name: 'browser: safari', description: 'Reproducible only in Safari (iOS/macOS)' },
  { name: 'bug', description: 'Unexpected behavior or functionality not working as intended' },
  { name: 'build', description: 'CI/CD, packaging, tooling, repository automation, agent instructions' },
  { name: 'dependency', description: 'Relates to external libraries/packages/actions or third-party services' },
  { name: 'device: mobile', description: 'Only affects small viewports or touch screens' },
  { name: 'docs', description: 'Changes to project docs site that do not affect core library logic' },
  { name: 'duplicate', description: 'Issue or pull request is redundant because an identical or closely related one already exists.' },
  { name: 'enhancement', description: 'Adds a new feature or enhances existing functionality (not fixing a defect) in the main library' },
  { name: 'epic', description: 'Multiple related tasks/issues that are summarized in one issue' },
  { name: 'extension', description: 'Related to a third-party community component that is directly associated with MudBlazor' },
  { name: 'fixed', description: 'Issue has been resolved and the fix is merged' },
  { name: 'good first issue', description: 'Limited scope with clear acceptance criteria; suitable for new contributors' },
  { name: 'hacktoberfest', description: 'Hacktoberfest 2021' },
  { name: 'hacktoberfest-accepted', description: 'Issues and PRs which were accepted as Hacktoberfest submissions' },
  { name: 'has workaround', description: 'Bug issues only: A temporary or alternative solution is available and documented in the thread' },
  { name: 'help wanted', description: 'Issue is suitable for help from community members' },
  { name: 'invalid', description: 'Not valid for consideration (spam, irrelevant, abusive, or missing actionable content)' },
  { name: 'legendary', description: 'Marks contributions that are highly valuable, innovative, or significantly impactful to the project' },
  { name: 'localization', description: 'Translations, locale formats, RTL layout, calendars' },
  { name: 'needs: changes', description: 'A maintainer has asked for further modifications to be made to this pull request' },
  { name: 'needs: example', description: 'A usage example is absent (reproduction link or code snippet)' },
  { name: 'needs: info', description: 'This issue/PR lacks key context (goal, setup, environment)' },
  { name: 'needs: tests', description: 'A maintainer has explicitly asked for test cases to be added' },
  { name: 'needs: visuals', description: 'Missing screenshots or video for UI bugs or design changes' },
  { name: 'new component', description: 'Proposal or addition of a new component (apply this instead of enhancement)' },
  { name: 'not a bug', description: 'The reported behavior is intended' },
  { name: 'not planned', description: 'This will not be implemented at the current time (won\'t fix / wont fix)' },
  { name: 'on hold', description: 'Waiting until an external factor or future milestone (e.g., major release) is reached' },
  { name: 'performance', description: 'Related to time/memory/CPU/allocation performance characteristics' },
  { name: 'question', description: 'Usage/how-to/support request' },
  { name: 'refactor', description: 'Reorganizes code with no changes to the API or functionality in the main library or other benefits' },
  { name: 'regression', description: 'Previously worked and now doesn\'t' },
  { name: 'security', description: 'Security vulnerabilities or data protection risks' },
  { name: 'skip changelog', description: 'Omitted from release notes: reverted, or a follow-up to a PR in the same release cycle' },
  { name: 'stale', description: 'Issue or PR has had no activity and is subject to automatic closure if not updated' },
  { name: 'tests', description: 'Updating tests or test infrastructure is the primary focus and there are no changes the main library' },
];

// Passed in reverse, so the snapshots also pin the order the prompt and the schema sort labels into.
const REPO_LABELS = [...LABELS].reverse();

const POLICY = `# Triage policy

## Labels
- Give every open issue and pull request exactly one kind label: \`bug\`, \`enhancement\`, \`docs\` or \`question\`.
- Add \`blazor: wasm\` or \`blazor: server\` only when the report says the problem happens with that hosting model alone.

## Missing information
- When a bug report has no reproduction, add \`needs: example\` and post one short comment asking for a minimal reproduction. Don't ask again if a maintainer already has.

## Closing
- Close an issue as \`not_planned\` when its author says it's no longer needed, without commenting.
`;

const README = `# Widgets

A Blazor component library with Material-style inputs, tables and dialogs.

## Getting help

Ask usage questions in Discussions. Report bugs with a minimal reproduction on try.widgets.dev.
`;

// Raw GitHub payloads, mapped by GitHubClient, so a change to how an item reaches the prompt shows up here too.
const ITEMS: Record<number, { issue: object; timeline: object[]; files?: object[]; reviewComments?: object[] }> = {
  101: {
    issue: {
      number: 101,
      title: 'Select shows an empty value after a hot reload',
      state: 'open',
      state_reason: null,
      user: { login: 'reporter', type: 'User' },
      author_association: 'NONE',
      locked: false,
      milestone: null,
      created_at: '2026-09-28T08:15:00Z',
      updated_at: '2026-09-29T10:02:00Z',
      closed_at: null,
      comments: 1,
      reactions: { total_count: 3 },
      labels: [{ name: 'awaiting triage' }, { name: 'bug' }],
      assignees: [],
      body: [
        '### What happened?',
        '',
        'After a hot reload, `Select` shows an empty value even though `@bind-Value` still holds "Medium".',
        '',
        '<!-- Include a reproduction link if you can. -->',
        '',
        '### Expected behavior',
        '',
        'The selected value stays visible.',
        '',
        '### Version',
        '',
        '9.1.0, WebAssembly',
      ].join('\n'),
    },
    timeline: [
      {
        id: 9001,
        url: 'https://api.github.com/repos/acme/widgets/issues/events/9001',
        actor: { login: 'github-actions[bot]', type: 'Bot' },
        event: 'labeled',
        created_at: '2026-09-28T08:15:05Z',
        label: { name: 'awaiting triage', color: 'ededed' },
      },
      {
        id: 9002,
        url: 'https://api.github.com/repos/acme/widgets/issues/comments/9002',
        actor: { login: 'another-user', type: 'User' },
        author_association: 'NONE',
        event: 'commented',
        created_at: '2026-09-29T10:02:00Z',
        updated_at: '2026-09-29T10:02:00Z',
        body: 'Same here on 9.1.0 with WebAssembly. Server hosting works fine.',
      },
    ],
  },
  102: {
    issue: {
      number: 102,
      title: 'Keep the selected value when Select re-renders',
      state: 'open',
      state_reason: null,
      user: { login: 'contributor', type: 'User' },
      author_association: 'CONTRIBUTOR',
      draft: false,
      locked: false,
      milestone: { title: '9.2.0' },
      created_at: '2026-09-30T09:00:00Z',
      updated_at: '2026-10-01T05:40:10Z',
      closed_at: null,
      comments: 1,
      reactions: { total_count: 0 },
      labels: [{ name: 'awaiting triage' }],
      assignees: [{ login: 'maintainer' }],
      body: 'Fixes #101.\n\n`Select` now reads its value from the parameter on every render, so a hot reload no longer clears it.\n\n- [x] Added a test',
      pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/102' },
    },
    timeline: [
      {
        sha: '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345',
        url: 'https://api.github.com/repos/acme/widgets/git/commits/3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345',
        author: { name: 'Contributor', email: 'contributor@example.com', date: '2026-09-30T08:55:00Z' },
        committer: { name: 'Contributor', email: 'contributor@example.com', date: '2026-09-30T08:55:00Z' },
        message: 'Keep the selected value when Select re-renders',
        event: 'committed',
      },
      {
        id: 9101,
        url: 'https://api.github.com/repos/acme/widgets/issues/events/9101',
        actor: { login: 'github-actions[bot]', type: 'Bot' },
        event: 'labeled',
        created_at: '2026-09-30T09:00:05Z',
        label: { name: 'awaiting triage', color: 'ededed' },
      },
      {
        id: 9102,
        url: 'https://api.github.com/repos/acme/widgets/issues/comments/9102',
        actor: { login: 'maintainer', type: 'User' },
        author_association: 'MEMBER',
        event: 'commented',
        created_at: '2026-10-01T05:00:00Z',
        updated_at: '2026-10-01T05:00:00Z',
        body: 'Thanks! Could the test also cover the first render on the server?',
      },
      {
        id: 9103,
        user: { login: 'maintainer', type: 'User' },
        author_association: 'MEMBER',
        body: 'Looks good apart from the test.',
        state: 'changes_requested',
        submitted_at: '2026-10-01T05:01:00Z',
        html_url: 'https://github.com/acme/widgets/pull/102#pullrequestreview-9103',
        event: 'reviewed',
      },
      {
        sha: '8a7b6c5d4e3f20112233445566778899aabbccdd',
        url: 'https://api.github.com/repos/acme/widgets/git/commits/8a7b6c5d4e3f20112233445566778899aabbccdd',
        author: { name: 'Contributor', email: 'contributor@example.com', date: '2026-10-01T05:40:00Z' },
        committer: { name: 'Contributor', email: 'contributor@example.com', date: '2026-10-01T05:40:00Z' },
        message: 'Cover the first server render in the test',
        event: 'committed',
      },
    ],
    files: [
      { filename: 'src/Components/Select/Select.razor.cs', status: 'modified' },
      { filename: 'tests/Components/SelectTests.cs', status: 'modified' },
    ],
    reviewComments: [
      {
        id: 9201,
        user: { login: 'maintainer', type: 'User' },
        author_association: 'MEMBER',
        created_at: '2026-10-01T05:01:00Z',
        updated_at: '2026-10-01T05:01:00Z',
        body: 'This also has to run on the first render.',
        path: 'src/Components/Select/Select.razor.cs',
      },
    ],
  },
};

// Model replies for each item's fast pass.
const FAST_REPLIES: Record<number, unknown> = {
  101: {
    summary: 'Select shows an empty value after a hot reload on WebAssembly 9.1.0, with no reproduction yet.',
    operations: [
      { kind: 'add_labels', labels: ['blazor: wasm', 'needs: example'], authorization: 'Labels: hosting model; Missing information: no reproduction.' },
      { kind: 'comment', body: 'Thanks for the report! Could you share a minimal reproduction on try.widgets.dev?', authorization: 'Missing information: ask for a minimal reproduction.' },
    ],
  },
  102: {
    summary: 'Fixes #101 by reading the Select value on every render; a maintainer asked for a server render test.',
    operations: [
      { kind: 'add_labels', labels: ['bug'], authorization: 'Labels: exactly one kind label.' },
    ],
  },
};

const octokit = {
  rest: {
    issues: { get: async ({ issue_number }: { issue_number: number }) => ({ data: ITEMS[issue_number]!.issue }) },
    pulls: { listFiles: 'listFiles', listReviewComments: 'listReviewComments' },
  },
  paginate: async (route: unknown, { issue_number, pull_number }: { issue_number?: number; pull_number?: number }) => {
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline') return ITEMS[issue_number!]!.timeline;
    if (route === 'listFiles') return ITEMS[pull_number!]!.files;
    if (route === 'listReviewComments') return ITEMS[pull_number!]!.reviewComments;
    throw new Error(`unexpected route ${String(route)}`);
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function systemPrompt(policy: 'builtin' | 'policy', mode: 'fast' | 'pro'): string {
  // Without a policy file, loadPrompt falls back to the built-in policy and warns.
  if (policy === 'builtin') vi.spyOn(console, 'warn').mockImplementation(() => {});
  const files = policy === 'builtin' ? { 'README.md': README } : { 'AutoTriage.prompt': POLICY, 'README.md': README };
  return withTempFiles(files, file => buildSystemPrompt(file('AutoTriage.prompt'), file('README.md'), REPO_LABELS, undefined, mode, LIMITS[mode]));
}

// The review pass's user prompt, built from the item as processIssue loads it.
async function userPrompt(number: number, lastTriaged: string | undefined, withFastPlan: boolean): Promise<string> {
  mocks.getOctokit.mockReturnValue(octokit);
  const gh = new GitHubClient('token', 'acme', 'widgets');
  const issue = await gh.getIssue(number);
  const { raw, filtered } = await gh.listTimelineEvents(number, LIMITS.pro.timelineEvents, issue.type === 'pull request');
  const runContext = buildRunContext(issue, raw, lastTriaged, false, (item, events) => gh.lastUpdated(item, events));
  const plan = withFastPlan ? fastPassPlan(issue, FAST_REPLIES[number]) : undefined;
  return buildUserPrompt(issue, filtered, 'pro', LIMITS.pro, runContext, plan, RUN_TIMESTAMP);
}

// The plan the fast pass hands the review pass, built from its reply as generateAnalysis builds it.
function fastPassPlan(issue: Issue, reply: unknown): FastPassPlan {
  const analysis = parseAnalysisResult(reply);
  return { analysis, operations: planOperations(issue, analysis, issue, LABELS.map(label => label.name), explainPlan(analysis)) };
}

describe.each(['fast', 'pro'] as const)('%s system prompt', (mode) => {
  it('with the built-in policy and a README', async () => {
    await expect(systemPrompt('builtin', mode)).toMatchFileSnapshot(snapshot(`system-${mode}-builtin.md`));
  });

  it('with a policy file and README', async () => {
    await expect(systemPrompt('policy', mode)).toMatchFileSnapshot(snapshot(`system-${mode}-policy.md`));
  });
});

describe.each([
  ['issue', 101, undefined],
  ['pr', 102, '2026-09-30T12:00:00Z'],
] as const)('%s user prompt', (name, number, lastTriaged) => {
  it('without a fast-pass plan', async () => {
    await expect(await userPrompt(number, lastTriaged, false)).toMatchFileSnapshot(snapshot(`user-${name}.md`));
  });

  it('with a fast-pass plan', async () => {
    await expect(await userPrompt(number, lastTriaged, true)).toMatchFileSnapshot(snapshot(`user-${name}-fast-plan.md`));
  });
});

it('response schema for a repository with 46 labels', async () => {
  expect(LABELS).toHaveLength(46);
  await expect(json(buildAnalysisResultSchema(REPO_LABELS))).toMatchFileSnapshot(snapshot('schema.json'));
});

it('request body for a host that does not enforce the schema', async () => {
  const bodies: unknown[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const reply = { choices: [{ message: { content: '{"summary":"","operations":[]}' }, finish_reason: 'stop' }] };
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  }) as Fetch;
  const claude = { baseUrl: 'https://api.anthropic.com/v1', host: 'api.anthropic.com', apiKey: 'test-key', keyName: 'ANTHROPIC_API_KEY' };

  // The prompts are pinned above, so short stand-ins keep this snapshot to what the client adds around them.
  const request = { model: 'claude-haiku-5-5', systemPrompt: 'System prompt.\n', userPrompt: 'User prompt.\n', schema: buildAnalysisResultSchema(REPO_LABELS) };
  await new ChatClient(claude, fetch).generateJson(request, parseAnalysisResult);

  expect(bodies).toHaveLength(1);
  await expect(json(bodies[0])).toMatchFileSnapshot(snapshot('request-body-schema-in-prompt.json'));
});
