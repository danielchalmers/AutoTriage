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
  // The commit the run reads the policy and README at (GITHUB_SHA). A local run has none and reads the default branch.
  sha?: string;
  dbPath?: string;
  // The endpoint that serves every analysis, and its model ID.
  model: Endpoint;
  limits: PromptLimits;
  maxProRuns: number;
  additionalInstructions?: string;
  extended: boolean;
}
