import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry, getDbEntry } from './storage';
import { AnalysisResult, buildPrompt, AnalysisResultSchema } from './analysis';
import { GitHubClient, Issue } from './github';
import { buildJsonPayload, GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';
import { buildAutoDiscoverQueue } from './autoDiscover';
import { ActionSummary, formatActionSummary } from './summary';
import chalk from 'chalk';

chalk.level = 3;

const cfg = getConfig();
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const gemini = new GeminiClient(cfg.geminiApiKey);

async function run(): Promise<void> {
  const startTime = Date.now();
  const repoLabels = await gh.listRepoLabels();
  const { targets, autoDiscover } = await listTargets();
  let triagesPerformed = 0;
  let consecutiveFailures = 0;
  const actionSummaries: ActionSummary[] = [];
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalResponseTokens = 0;
  let totalThoughtsTokens = 0;

  console.log(`⚙️ Enabled: ${cfg.enabled ? 'yes' : 'dry-run'}`);
  console.log(`▶️ Triaging up to ${cfg.maxTriages} item(s) out of ${targets.length} from ${cfg.owner}/${cfg.repo} (${autoDiscover ? "auto-discover" : targets.map(t => `#${t}`).join(', ')})`);

  try {
    for (const n of targets) {
      const remaining = cfg.maxTriages - triagesPerformed;
      if (remaining <= 0) {
        console.log(`⏳ Max triages (${cfg.maxTriages}) reached`);
        break;
      }

      try {
        const issue = await gh.getIssue(n);
        const { triageUsed, operations, tokenUsage } = await processIssue(issue, repoLabels, autoDiscover);
        if (triageUsed) {
          triagesPerformed++;
          if (operations.length > 0) {
            actionSummaries.push({ issueNumber: issue.number, operations });
          }
          // Accumulate token usage
          totalTokens += tokenUsage.totalTokens;
          totalPromptTokens += tokenUsage.promptTokens;
          totalResponseTokens += tokenUsage.responseTokens;
          totalThoughtsTokens += tokenUsage.thoughtsTokens;
        }
        consecutiveFailures = 0; // reset on success path
      } catch (err) {
        if (err instanceof GeminiResponseError) {
          console.warn(`#${n}: ${err.message}`);
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            console.error(`Analysis failed ${consecutiveFailures} consecutive times; stopping further processing.`);
            break;
          }
          continue;
        }
        // Re-throw non-Gemini errors to stop processing
        throw err;
      }

      if (triagesPerformed >= cfg.maxTriages) {
        console.log(`⏳ Max triages (${cfg.maxTriages}) reached`);
        break;
      }

      saveDatabase(db, cfg.dbPath, cfg.enabled);
    }
  } finally {
    const endTime = Date.now();
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);
    
    // Always print summary if there are actions
    if (actionSummaries.length > 0) {
      printActionSummary(actionSummaries);
    }
    
    // Print run statistics
    printRunStatistics({
      issuesProcessed: triagesPerformed,
      issuesTargeted: targets.length,
      actionsPerformed: actionSummaries.reduce((sum, s) => sum + s.operations.length, 0),
      totalTokens,
      promptTokens: totalPromptTokens,
      responseTokens: totalResponseTokens,
      thoughtsTokens: totalThoughtsTokens,
      durationSeconds,
      autoDiscover
    });
  }
}

run();

function printActionSummary(actionSummaries: ActionSummary[]): void {
  console.log('\n' + chalk.bold.cyan('📋 Summary of Actions Performed:'));
  
  const lines = formatActionSummary(actionSummaries);
  for (const line of lines) {
    console.log(`  ${chalk.yellow(line)}`);
  }
}

interface RunStatistics {
  issuesProcessed: number;
  issuesTargeted: number;
  actionsPerformed: number;
  totalTokens: number;
  promptTokens: number;
  responseTokens: number;
  thoughtsTokens: number;
  durationSeconds: string;
  autoDiscover: boolean;
}

function printRunStatistics(stats: RunStatistics): void {
  console.log('\n' + chalk.bold.cyan('📊 Run Statistics:'));
  console.log(`  ${chalk.gray('Issues targeted:')} ${stats.issuesTargeted}`);
  console.log(`  ${chalk.gray('Issues processed:')} ${stats.issuesProcessed}`);
  console.log(`  ${chalk.gray('Actions performed:')} ${stats.actionsPerformed}`);
  console.log(`  ${chalk.gray('Total tokens:')} ${stats.totalTokens.toLocaleString()}`);
  console.log(`  ${chalk.gray('  • Prompt tokens:')} ${stats.promptTokens.toLocaleString()}`);
  console.log(`  ${chalk.gray('  • Response tokens:')} ${stats.responseTokens.toLocaleString()}`);
  console.log(`  ${chalk.gray('  • Thoughts tokens:')} ${stats.thoughtsTokens.toLocaleString()}`);
  console.log(`  ${chalk.gray('Duration:')} ${stats.durationSeconds}s`);
  console.log(`  ${chalk.gray('Mode:')} ${stats.autoDiscover ? 'auto-discovery' : 'explicit targets'}`);
}

interface TokenUsage {
  totalTokens: number;
  promptTokens: number;
  responseTokens: number;
  thoughtsTokens: number;
}

async function processIssue(
  issue: Issue,
  repoLabels: Array<{ name: string; description?: string | null }>,
  autoDiscover: boolean
): Promise<{ triageUsed: boolean; operations: TriageOperation[]; tokenUsage: TokenUsage }> {
  const dbEntry = getDbEntry(db, issue.number);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(issue.number, cfg.maxTimelineEvents);

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

    const { systemPrompt, userPrompt } = await buildPrompt(
      issue,
      cfg.promptPath,
      cfg.readmePath,
      timelineEvents,
      repoLabels,
      dbEntry.thoughts || '',
      cfg.additionalInstructions
    );

    saveArtifact(issue.number, `prompt-system.md`, systemPrompt);
    saveArtifact(issue.number, `prompt-user.md`, userPrompt);

    let tokenUsage: TokenUsage = { totalTokens: 0, promptTokens: 0, responseTokens: 0, thoughtsTokens: 0 };

    // Pass 1: fast model (unless skip-fast-pass is enabled)
    if (!cfg.skipFastPass) {
      const { data: quickAnalysis, thoughts: quickThoughts, ops: quickOps, usage: quickUsage } = await generateAnalysis(
        issue,
        cfg.modelFast,
        cfg.modelTemperature,
        cfg.thinkingBudget,
        systemPrompt,
        userPrompt,
        repoLabels
      );

      tokenUsage.totalTokens += quickUsage.totalTokens;
      tokenUsage.promptTokens += quickUsage.promptTokens;
      tokenUsage.responseTokens += quickUsage.responseTokens;
      tokenUsage.thoughtsTokens += quickUsage.thoughtsTokens;

      // Fast pass produced no work: skip expensive pass.
      if (quickOps.length === 0) {
        console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
        updateDbEntry(db, issue.number, quickAnalysis.summary || issue.title, quickThoughts);
        return { triageUsed: false, operations: [], tokenUsage };
      }
    } else {
      console.log(chalk.blue('Fast pass skipped; using pro model directly.'));
    }

    // Pass 2: pro model (or only pass if skip-fast-pass is enabled)
    const { data: proAnalysis, thoughts: proThoughts, ops: proOps, usage: proUsage } = await generateAnalysis(
      issue,
      cfg.modelPro,
      cfg.modelTemperature,
      cfg.thinkingBudget,
      systemPrompt,
      userPrompt,
      repoLabels
    );

    tokenUsage.totalTokens += proUsage.totalTokens;
    tokenUsage.promptTokens += proUsage.promptTokens;
    tokenUsage.responseTokens += proUsage.responseTokens;
    tokenUsage.thoughtsTokens += proUsage.thoughtsTokens;

    if (proOps.length === 0) {
      console.log(chalk.yellow('Pro model suggested no operations; skipping further processing.'));
    } else {
      saveArtifact(issue.number, 'operations.json', JSON.stringify(proOps.map(o => o.toJSON()), null, 2));
      for (const op of proOps) {
        await op.perform(gh, cfg, issue);
      }
    }

    updateDbEntry(db, issue.number, proAnalysis.summary || issue.title, proThoughts);
    return { triageUsed: true, operations: proOps, tokenUsage };
  });
}

export async function generateAnalysis(
  issue: Issue,
  model: string,
  modelTemperature: number,
  thinkingBudget: number,
  systemPrompt: string,
  userPrompt: string,
  repoLabels: Array<{ name: string; description?: string | null }>,
): Promise<{ data: AnalysisResult; thoughts: string, ops: TriageOperation[]; usage: TokenUsage }> {
  const payload = buildJsonPayload(
    systemPrompt,
    userPrompt,
    AnalysisResultSchema,
    model,
    modelTemperature,
    thinkingBudget
  );

  console.log(chalk.blue(`💭 Thinking with ${model}...`));
  const { data, thoughts, usageMetadata } = await gemini.generateJson<AnalysisResult>(payload, 2, 5000);
  console.log(chalk.magenta(thoughts));
  saveArtifact(issue.number, `${model}-analysis.json`, JSON.stringify(data, null, 2));
  saveArtifact(issue.number, `${model}-thoughts.txt`, thoughts);

  const ops: TriageOperation[] = planOperations(issue, data, issue, repoLabels.map(l => l.name), thoughts);

  const usage: TokenUsage = {
    totalTokens: usageMetadata?.totalTokenCount ?? 0,
    promptTokens: usageMetadata?.promptTokenCount ?? 0,
    responseTokens: usageMetadata?.candidatesTokenCount ?? 0,
    thoughtsTokens: usageMetadata?.thoughtsTokenCount ?? 0
  };

  return { data, thoughts, ops, usage };
}

async function listTargets(): Promise<{ targets: number[], autoDiscover: boolean }> {
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return { targets: fromInput, autoDiscover: false };

  // Event payload single target (issue or PR) takes priority over fallback listing.
  const payload: any = (await import('@actions/github')).context.payload;
  const num = payload?.issue?.number || payload?.pull_request?.number;
  if (num) return { targets: [Number(num)], autoDiscover: false };

  // Fallback: auto-discover mode prioritizes new/updated work first, then cycles through the rest.
  const issues = await gh.listOpenIssues();
  const orderedNumbers = buildAutoDiscoverQueue(issues, db);
  return { targets: orderedNumbers, autoDiscover: true };
}
