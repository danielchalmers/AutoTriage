export type TriagePassStrategy = 'pro-only' | 'fast-then-pro';

export type TriagePassScenario =
  | 'never-triaged'
  | 'new-context'
  | 'no-new-context-extended'
  | 'no-new-context-explicit';

export interface TriagePassSelectionInput {
  lastTriagedAt?: string;
  latestUpdateMs: number;
  autoDiscover: boolean;
}

export interface TriagePassSelection {
  strategy: TriagePassStrategy;
  scenario: TriagePassScenario;
  hasNewContext: boolean;
}

function parseDate(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectTriagePassSelection({
  lastTriagedAt,
  latestUpdateMs,
  autoDiscover,
}: TriagePassSelectionInput): TriagePassSelection {
  if (!lastTriagedAt) {
    return {
      strategy: 'pro-only',
      scenario: 'never-triaged',
      hasNewContext: true,
    };
  }

  const triagedMs = parseDate(lastTriagedAt);
  const hasNewContext = triagedMs === 0 || latestUpdateMs > triagedMs;
  if (hasNewContext) {
    return {
      strategy: 'pro-only',
      scenario: 'new-context',
      hasNewContext,
    };
  }

  if (autoDiscover) {
    return {
      strategy: 'fast-then-pro',
      scenario: 'no-new-context-extended',
      hasNewContext: false,
    };
  }

  return {
    strategy: 'pro-only',
    scenario: 'no-new-context-explicit',
    hasNewContext: false,
  };
}
