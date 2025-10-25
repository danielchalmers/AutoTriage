import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry, getDbEntry } from './storage';
import { AnalysisResult, buildPrompt, AnalysisResultSchema } from './analysis';
import { GitHubClient, Issue } from './github';
import { buildJsonPayload, GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';
import { buildAutoDiscoverQueue } from './autoDiscover';
import chalk from 'chalk';

chalk.level = 3;

const cfg = getConfig();
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const gemini = new GeminiClient(cfg.geminiApiKey);

async function run(): Promise<void> {
  const repoLabels = await gh.listRepoLabels();
  const { targets, autoDiscover } = await listTargets();
  let triagesPerformed = 0;
  let consecutiveFailures = 0;

  console.log(`⚙️ Enabled: ${cfg.enabled ? 'yes' : 'dry-run'}`);
  console.log(`▶️ Triaging up to ${cfg.maxTriages} item(s) out of ${targets.length} from ${cfg.owner}/${cfg.repo} (${autoDiscover ? "auto-discover" : targets.map(t => `#${t}`).join(', ')})`);

  for (const n of targets) {
    const remaining = cfg.maxTriages - triagesPerformed;
    if (remaining <= 0) {
      console.log(`⏳ Max triages (${cfg.maxTriages}) reached`);
      break;
    }

    try {
      const issue = await gh.getIssue(n);
      const triageUsed = await processIssue(issue, repoLabels, autoDiscover);
      if (triageUsed) triagesPerformed++;
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
}

run();

async function processIssue(
  issue: Issue,
  repoLabels: Array<{ name: string; description?: string | null }>,
  autoDiscover: boolean
): Promise<boolean> {
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
      dbEntry.thoughts || ''
    );

    saveArtifact(issue.number, `prompt-system.md`, systemPrompt);
    saveArtifact(issue.number, `prompt-user.md`, userPrompt);

    // Pass 1: fast model
    const { data: quickAnalysis, thoughts: quickThoughts, ops: quickOps } = await generateAnalysis(
      issue,
      cfg.modelFast,
      cfg.modelTemperature,
      cfg.thinkingBudget,
      systemPrompt,
      userPrompt,
      repoLabels
    );

    // Fast pass produced no work: skip expensive pass.
    if (quickOps.length === 0) {
      console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
      updateDbEntry(db, issue.number, quickAnalysis.summary || issue.title, quickThoughts);
      return false;
    }

    // Full analysis pass: pro model
    const { data: proAnalysis, thoughts: proThoughts, ops: proOps } = await generateAnalysis(
      issue,
      cfg.modelPro,
      cfg.modelTemperature,
      cfg.thinkingBudget,
      systemPrompt,
      userPrompt,
      repoLabels
    );

    if (proOps.length === 0) {
      console.log(chalk.yellow('Pro pass suggested no operations; skipping further processing.'));
    } else {
      saveArtifact(issue.number, 'operations.json', JSON.stringify(proOps.map(o => o.toJSON()), null, 2));
      for (const op of proOps) {
        await op.perform(gh, cfg, issue);
      }
    }

    updateDbEntry(db, issue.number, proAnalysis.summary || issue.title, proThoughts);
    return true;
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
): Promise<{ data: AnalysisResult; thoughts: string, ops: TriageOperation[] }> {
  const payload = buildJsonPayload(
    systemPrompt,
    userPrompt,
    AnalysisResultSchema,
    model,
    modelTemperature,
    thinkingBudget
  );

  console.log(chalk.blue(`💭 Thinking with ${model}...`));
  const { data, thoughts } = await gemini.generateJson<AnalysisResult>(payload, 2, 5000);
  console.log(chalk.magenta(thoughts));
  saveArtifact(issue.number, `${model}-analysis.json`, JSON.stringify(data, null, 2));
  saveArtifact(issue.number, `${model}-thoughts.txt`, thoughts);

  const ops: TriageOperation[] = planOperations(issue, data, issue, repoLabels.map(l => l.name), thoughts);

  return { data, thoughts, ops };
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
