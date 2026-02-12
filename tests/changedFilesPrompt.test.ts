import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../src/analysis'
import type { Issue, TimelineEvent } from '../src/github'
import * as fs from 'fs'
import * as path from 'path'

describe('changed files metadata', () => {
  it('includes changed filenames for pull requests', async () => {
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
    }
    const mockTimelineEvents: TimelineEvent[] = []
    const mockRepoLabels: Array<{ name: string; description?: string | null }> = []
    const changedFiles = ['src/index.ts', 'src/github.ts']
    const customPromptPath = path.join(__dirname, `test-changed-files-prompt-${Date.now()}.txt`)
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { userPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        changedFiles,
        mockRepoLabels,
        '',
        undefined
      )

      expect(userPrompt).toContain('=== SECTION: CHANGED FILES (JSON) ===')
      expect(userPrompt).toContain('"src/index.ts"')
      expect(userPrompt).toContain('"src/github.ts"')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })
})
