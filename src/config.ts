import type { Endpoint } from './llm/endpoint';

export type PromptPassMode = 'fast' | 'pro';

export type PromptPassLimits = {
  readmeChars: number;
  issueBodyChars: number;
  timelineEvents: number;
  timelineTextChars: number;
};

export interface Config {
  owner: string;
  repo: string;
  token: string;
  dryRun: boolean;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  readmePath: string;
  dbPath?: string;
  skipFastPass: boolean;
  // The IDs sent to each pass's API; modelFast is '' when the fast pass is skipped.
  modelFast: string;
  modelPro: string;
  // The endpoint that serves each pass; fast is null when the fast pass is skipped.
  models: { fast: Endpoint | null; pro: Endpoint };
  limits: Record<PromptPassMode, PromptPassLimits>;
  maxProRuns: number;
  maxFastRuns: number;
  additionalInstructions?: string;
  extended: boolean;
  strictMode: boolean;
}
