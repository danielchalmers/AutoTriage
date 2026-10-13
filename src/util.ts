import { styleText } from 'node:util';

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

// GitHub renders ANSI colors in the log, but its log isn't a TTY, so colors are always on.
export function color(format: Parameters<typeof styleText>[0], text: string): string {
  return styleText(format, text, { validateStream: false });
}
