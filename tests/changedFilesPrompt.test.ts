import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../src/analysis'
import type { Issue, TimelineEvent } from '../src/github'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('changed files metadata', () => {
  it('includes changed filenames for pull requests', async () => {
    const changedFiles = ['src/index.ts', 'src/github.ts']
    const mockIssue: Issue = {
      title: 'Test PR',
      state: 'open',
      type: 'pull request',
      number: 42,
      author: 'testuser',
      user_type: 'User',
      draft: false,
      locked: false,
      milestone: null,
      comments: 0,
      reactions: 0,
      labels: [],
      assignees: [],
      body: 'Test pull request',
      changed_files: changedFiles,
    }
    const mockTimelineEvents: TimelineEvent[] = []
    const mockRepoLabels: Array<{ name: string; description?: string | null }> = []
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-'))
    const customPromptPath = path.join(tempDir, 'test-changed-files-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { userPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        mockRepoLabels,
        '',
        undefined
      )

      expect(userPrompt).toContain('"changed_files"')
      expect(userPrompt).toContain('"src/index.ts"')
      expect(userPrompt).toContain('"src/github.ts"')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
