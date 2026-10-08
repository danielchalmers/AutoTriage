// Small helpers shared across modules.
// Kept dependency-free so any module can import them without creating cycles.

// Message-only form, for warnings where a stack would be noise.
// Network failures carry their code on the cause (fetch only says "fetch failed"), so it is appended when present.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message + causeCode(error) : String(error);
}

function causeCode(error: Error): string {
  const cause = 'cause' in error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
}

// Stack-preferring form, for failures that end a run or an item and need to stay diagnosable.
export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

// Parse an ISO timestamp to epoch milliseconds, returning 0 for missing or unparseable values.
export function parseTimestamp(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
