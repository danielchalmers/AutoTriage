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
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  readmePath: string;
  dbPath?: string;
  model: Endpoint;
  limits: PromptLimits;
  maxRuns: number;
  additionalInstructions?: string;
  extended: boolean;
}
