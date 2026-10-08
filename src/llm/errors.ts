// Error text helpers for model calls.
// Kept here rather than in a shared util module so src/llm/ imports nothing from outside itself.

// Message-only form, for warnings where a stack would be noise.
// Network failures carry their code on the cause (fetch only says "fetch failed"), so it is appended when present.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message + causeCode(error) : String(error);
}

function causeCode(error: Error): string {
  const cause = 'cause' in error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
}
