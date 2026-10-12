import { describe, expect, it, vi } from 'vitest'
import { POLICY_PATH, buildSystemPrompt, readPromptSources } from '../src/prompts'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt'
import { githubError } from './fixtures'

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

  it('puts the policy text in the behavior policy section and the README, cut to its limit, in its own section', () => {
    const readme = `# Project\n${'x'.repeat(100)}`

    const prompt = buildSystemPrompt('Label bugs.', readme, labels, undefined, { readmeChars: 20 })

    expect(prompt).toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY ===\nLabel bugs.\n')
    expect(prompt).not.toContain(BUILTIN_LABEL_ONLY_PROMPT)
    expect(prompt).toContain(`=== SECTION: PROJECT README (MARKDOWN) ===\n${readme.slice(0, 20)}\n`)
    expect(prompt).not.toContain(readme.slice(0, 21))
  })

  it('uses the built-in label-only policy for a null policy and leaves the README section out without a README', () => {
    const prompt = buildSystemPrompt(null, null, labels)

    expect(prompt).toContain(`=== SECTION: ASSISTANT BEHAVIOR POLICY ===\n${BUILTIN_LABEL_ONLY_PROMPT}\n`)
    expect(prompt).not.toContain('PROJECT README (MARKDOWN)')
  })
})
