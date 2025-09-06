export type AnalysisResult = {
  // A canonical, stable summary of the core problem for duplicate detection
  summary: string;
  // Full cumulative reasoning history
  reasoning: string;
  labels?: string[];
  comment?: string;
  close?: boolean;
  newTitle?: string;
};

export type TriageDb = Record<string, {
  lastTriaged: string;
  // Full cumulative reasoning history (append-only log)
  reasoning: string;
  // Canonical issue summary for duplicate detection
  summary: string;
  labels: string[];
}>; 

export type Config = {
  owner: string;
  repo: string;
  token: string;
  geminiApiKey: string;
  modelTemperature: number;
  enabled: boolean;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  dbPath?: string;
  modelFast: string;
  modelPro: string;
  maxTimelineEvents: number;
  maxOperations: number;
};
