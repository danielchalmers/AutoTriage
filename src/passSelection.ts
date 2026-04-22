export type AnalysisPassMode = 'fast' | 'pro';

export function chooseAnalysisPassMode(
  lastTriagedAt: string | undefined,
  latestUpdateMs: number,
  fastPassAvailable: boolean
): AnalysisPassMode {
  if (!fastPassAvailable) return 'pro';
  if (!lastTriagedAt) return 'pro';

  const triagedMs = Date.parse(lastTriagedAt);
  if (!Number.isFinite(triagedMs)) return 'pro';

  return latestUpdateMs > triagedMs ? 'pro' : 'fast';
}
