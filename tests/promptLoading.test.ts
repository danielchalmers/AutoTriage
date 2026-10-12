import { describe, expect, it, vi } from 'vitest'
import { POLICY_PATH, buildSystemPrompt, buildUserPrompt, readPromptSources } from '../src/prompts'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt'
import { githubError, makeIssue } from './fixtures'

const SHA = '0123456789abcdef0123456789abcdef01234567'

// A repository whose root holds rootFiles, and whose readable files are the keys of files.
function createGitHub(rootFiles: string[], files: Record<string, string>) {
  return {
    listRootFiles: vi.fn(async (_ref?: string) => rootFiles),
    readRepoFile: vi.fn(async (path: string, _ref?: string) => files[path] ?? null),
  }
}

describe('readPromptSources', () => {
  it('lists the root first, then reads the policy and the README at the commit', async () => {
    const gh = createGitHub(['LICENSE', 'README.md', 'package.json'], { [POLICY_PATH]: 'Label bugs.', 'README.md': '# Project' })

    const sources = await readPromptSources(gh, SHA)

    expect(sources).toEqual({ policy: 'Label bugs.', readme: { name: 'README.md', text: '# Project' } })
    expect(gh.listRootFiles).toHaveBeenCalledWith(SHA)
    expect(gh.readRepoFile.mock.calls).toEqual([[POLICY_PATH, SHA], ['README.md', SHA]])
    expect(gh.listRootFiles.mock.invocationCallOrder[0]).toBeLessThan(gh.readRepoFile.mock.invocationCallOrder[0]!)
  })

  it('leaves the policy null for the built-in policy when the repository has no policy file', async () => {
    const gh = createGitHub(['README.md'], { 'README.md': '# Project' })

    expect(await readPromptSources(gh, SHA)).toMatchObject({ policy: null, readme: { name: 'README.md' } })
  })

  it.each([
    [['CONTRIBUTING.md', 'readme'], 'readme'],
    [['README', 'README.txt', 'readme.markdown'], 'readme.markdown'],
    [['README.TXT', 'Readme.md'], 'Readme.md'],
    [['README-dev.md', 'READMEmd', 'README.rst'], null],
    [[], null],
  ])('picks the README from the root files %j', async (rootFiles, expected) => {
    const files = Object.fromEntries(rootFiles.map((name) => [name, `text of ${name}`]))
    const gh = createGitHub(rootFiles, files)

    const { readme } = await readPromptSources(gh, SHA)

    expect(readme).toEqual(expected ? { name: expected, text: `text of ${expected}` } : null)
    expect(gh.readRepoFile).toHaveBeenCalledTimes(expected ? 2 : 1)
  })

  it('reads the default branch on a local run, which has no commit', async () => {
    const gh = createGitHub(['README.md'], { [POLICY_PATH]: 'Label bugs.', 'README.md': '# Project' })

    await readPromptSources(gh, undefined)

    expect(gh.listRootFiles).toHaveBeenCalledWith(undefined)
    expect(gh.readRepoFile.mock.calls).toEqual([[POLICY_PATH, undefined], ['README.md', undefined]])
  })

  it('lets a transient failure reading the policy through, instead of falling back to the built-in policy', async () => {
    const gh = createGitHub(['README.md'], {})
    gh.readRepoFile.mockRejectedValueOnce(githubError(503, 'Service Unavailable'))

    await expect(readPromptSources(gh, SHA)).rejects.toThrow('Service Unavailable')
  })
})

describe('buildSystemPrompt', () => {
  const labels = [{ name: 'bug', description: 'Something is broken' }]

  it('puts the policy text in the behavior policy section and the README, cut to 120,000 characters, in its own section', () => {
    const readme = `# Project\n${'x'.repeat(130000)}`

    const prompt = buildSystemPrompt('Label bugs.', readme, labels)

    expect(prompt).toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY ===\nLabel bugs.\n\n=== SECTION: REPOSITORY LABELS (JSON) ===\n')
    expect(prompt).not.toContain(BUILTIN_LABEL_ONLY_PROMPT)
    expect(prompt).toContain(`=== SECTION: PROJECT README (MARKDOWN) ===\n${readme.slice(0, 120000)}\n`)
    expect(prompt).not.toContain(readme.slice(0, 120001))
  })

  it('uses the built-in label-only policy for a null policy and leaves the README section out without a README', () => {
    const prompt = buildSystemPrompt(null, null, labels)

    expect(prompt).toContain(`=== SECTION: ASSISTANT BEHAVIOR POLICY ===\n${BUILTIN_LABEL_ONLY_PROMPT}\n`)
    expect(prompt).not.toContain('PROJECT README (MARKDOWN)')
  })
})

describe('BUILTIN_LABEL_ONLY_PROMPT', () => {
  it('only adds labels, and never removes or corrects them', () => {
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- You may only emit `add_labels` operations. Never emit `remove_labels`, `comment`, `set_state`, or `set_title` operations.\n')
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- Never remove, replace, or "correct" existing labels.\n')
  })

  it('gives every item exactly one kind label whoever opened it, recognizing kinds by description', () => {
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('Recognize kind labels by their description, or by their name when they have none')
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- Every issue and pull request MUST end up with exactly one kind label, whoever opened it. A maintainer, owner or bot author changes nothing')
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- If the item already has a kind label, add no other kind label.\n')
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('a pull request that fixes broken behavior is a defect fix whatever its title says')
  })

  it('holds other labels to their descriptions, and leaves out language, ecosystem and tool labels', () => {
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- Add any other label only when the item itself, or a maintainer\'s comment on it, clearly meets that label\'s description.')
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- Do not add a label that only names a programming language, ecosystem or tool')
    expect(BUILTIN_LABEL_ONLY_PROMPT).toMatch(/- If no label should be added, return an empty operations array\.$/)
  })
})

describe('buildUserPrompt', () => {
  it('cuts the body to 20,000 characters and keeps the latest 40 timeline events, each cut to 4,000 characters', () => {
    const issue = makeIssue(1, '2026-10-01T00:00:00Z', { body: 'b'.repeat(20001) })
    const events = Array.from({ length: 41 }, (_, i) => ({ event: 'commented', body: `${i}:${'c'.repeat(4000)}` }))

    const prompt = buildUserPrompt(issue, events, 'First review.', '2026-10-11T00:00:00.000Z')

    expect(prompt).toContain(`"body": "${'b'.repeat(20000)}",`)
    expect(prompt).not.toContain('"body": "0:')
    expect(prompt).toContain(`"body": "1:${'c'.repeat(3998)}"`)
    expect(prompt).toContain(`"body": "40:${'c'.repeat(3997)}"`)
  })
})
