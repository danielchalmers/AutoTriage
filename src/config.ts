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
  geminiApiKey: string;
  dryRun: boolean;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  readmePath: string;
  dbPath?: string;
  skipFastPass: boolean;
  modelFast: string;
  modelPro: string;
  limits: Record<PromptPassMode, PromptPassLimits>;
  maxProRuns: number;
  maxFastRuns: number;
  additionalInstructions?: string;
  extended: boolean;
  strictMode: boolean;
}
