import type { Endpoint } from './llm/endpoint';

export interface Config {
  owner: string;
  repo: string;
  token: string;
  dryRun: boolean;
  // The explicit issues input, which is never empty when set.
  issueNumbers?: number[];
  // The commit the run reads the policy and README at (GITHUB_SHA). A local run has none and reads the default branch.
  sha?: string;
  // The endpoint that serves every analysis, and its model ID.
  model: Endpoint;
}
