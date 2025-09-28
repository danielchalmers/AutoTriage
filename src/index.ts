import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveArtifact, saveDatabase, writeAnalysisToDb, parseDbEntry } from './storage';
import { AnalysisResult, buildPrompt, AnalysisResultSchema } from './analysis';
import { GitHubClient, Issue } from './github';
import { buildJsonPayload, GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';

const cfg = getConfig();
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const gemini = new GeminiClient(cfg.geminiApiKey);

async function run(): Promise<void> {
  const repoLabels = await gh.listRepoLabels();
  const { targets, autoDiscover } = await listTargets();
  let triagesPerformed = 0;
  let consecutiveFailures = 0;

  core.info(`⚙️ Enabled: ${cfg.enabled ? 'yes' : 'dry-run'}`);
  core.info(`▶️ Triaging up to ${cfg.maxTriages} item(s) out of ${targets.length} from ${cfg.owner}/${cfg.repo} (${autoDiscover ? "auto-discover" : targets.map(t => `#${t}`).join(', ')})`);

  for (const n of targets) {
    const remaining = cfg.maxTriages - triagesPerformed;
    if (remaining <= 0) {
      core.info(`⏳ Max triages (${cfg.maxTriages}) reached`);
      break;
    }

    try {
      const triageUsed = await processIssue(n, repoLabels, autoDiscover);
      if (triageUsed) triagesPerformed++;
      consecutiveFailures = 0; // reset on success path
    } catch (err) {
      if (err instanceof GeminiResponseError) {
        core.warning(`#${n}: ${err.message}`);
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          core.error(`Analysis failed ${consecutiveFailures} consecutive times; stopping further processing.`);
          break;
        }
        continue;
      }
      // Re-throw non-Gemini errors to stop processing
      throw err;
    }

    if (triagesPerformed >= cfg.maxTriages) {
      core.info(`⏳ Max triages (${cfg.maxTriages}) reached`);
      break;
    }

    saveDatabase(db, cfg.dbPath, cfg.enabled);
  }
}

run();

async function processIssue(
  issueNumber: number,
  repoLabels: Array<{ name: string; description?: string | null }>,
  autoDiscover: boolean
): Promise<boolean> {
  const issue = await gh.getIssue(issueNumber);
  const dbEntry = parseDbEntry(db, issueNumber);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(issue.number, cfg.maxTimelineEvents);
  saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

  if (autoDiscover) {
    // Skip items that haven't changed since last triage.
    if (!gh.hasUpdated(issue, timelineEvents, dbEntry.lastTriaged, dbEntry.reactions)) {
      return false;
    }
  }
  const { systemPrompt, userPrompt } = await buildPrompt(
    issue,
    cfg.promptPath,
    cfg.readmePath,
    timelineEvents,
    repoLabels,
    dbEntry.lastReasoning
  );

  saveArtifact(issue.number, `prompt-system.md`, systemPrompt);
  saveArtifact(issue.number, `prompt-user.md`, userPrompt);

  // Pass 1: fast model
  const { ops: quickOps } = await generateAnalysis(
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
    return false;
  }

  // Full analysis pass: pro model
  const { thoughts: reviewThoughts, ops: reviewOps } = await generateAnalysis(
    issue,
    cfg.modelPro,
    cfg.modelTemperature,
    cfg.thinkingBudget,
    systemPrompt,
    userPrompt,
    repoLabels
  );

  core.info(`🤖 #${issueNumber}:`);
  core.info(reviewThoughts.replace(/^/gm, '  💭 '));

  if (reviewOps.length > 0) {
    for (const op of reviewOps) {
      await op.perform(gh, cfg, issue);
    }
  }

  return true;
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

  const { data, thoughts } = await gemini.generateJson<AnalysisResult>(payload, 2, 5000);
  saveArtifact(issue.number, `${model}-analysis.json`, JSON.stringify(data, null, 2));
  saveArtifact(issue.number, `${model}-thoughts.txt`, thoughts);

  const ops: TriageOperation[] = planOperations(issue, data, issue, repoLabels.map(l => l.name));

  if (ops.length > 0) {
    saveArtifact(issue.number, 'operations.json', JSON.stringify(ops.map(o => o.toJSON()), null, 2));
  }

  writeAnalysisToDb(db, issue.number, data, issue.title, issue.reactions);

  return { data, thoughts, ops };
}

async function listTargets(): Promise<{ targets: number[], autoDiscover: boolean }> {
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return { targets: fromInput, autoDiscover: false };

  // Event payload single target (issue or PR) takes priority over fallback listing.
  const payload: any = (await import('@actions/github')).context.payload;
  const num = payload?.issue?.number || payload?.pull_request?.number;
  if (num) return { targets: [Number(num)], autoDiscover: false };

  // Fallback: process all open issues/PRs (ordered recent first) when nothing explicit given.
  const issues = await gh.listOpenIssues();
  return { targets: issues.map(i => i.number), autoDiscover: true };
}
