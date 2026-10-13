import type { Endpoint } from './llm/endpoint';

export type PromptLimits = {
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
  issueNumbers?: number[];
  promptPath: string;
  dbPath?: string;
  model: Endpoint;
  limits: PromptLimits;
  maxRuns: number;
  additionalInstructions?: string;
}
