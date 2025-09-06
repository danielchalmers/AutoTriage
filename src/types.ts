export type AnalysisResult = {
  reason: string;
  labels?: string[];
  comment?: string;
  close?: boolean;
  newTitle?: string;
};

export type TriageDb = Record<string, {
  lastTriaged: string;
  reason: string;
  labels: string[];
}>; 

export type Config = {
  owner: string;
  repo: string;
  token: string;
  geminiApiKey: string;
  enabled: boolean;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  dbPath?: string;
  modelFast: string;
  modelPro: string;
  labelAllowlist?: string[];
  maxTimelineEvents: number;
};
