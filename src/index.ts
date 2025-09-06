import * as core from '@actions/core';
import * as github from '@actions/github';

async function run(): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is not available. Ensure the workflow grants default token access.');
    }

    const issueInput = core.getInput('issue-number');
    const { context } = github;
    const { owner, repo } = context.repo;

    const issueNumber = issueInput
      ? Number(issueInput)
      : (context.payload as any)?.issue?.number as number | undefined;

    if (!issueNumber || Number.isNaN(issueNumber)) {
      throw new Error('No issue number provided or found in the event payload.');
    }

    const octokit = github.getOctokit(token);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: 'Test',
    });

    core.info(`Posted comment to ${owner}/${repo}#${issueNumber}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

run();

