import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Only failing tests print their console output, so tests that check a log line spy on console explicitly.
    silent: 'passed-only',
    // The proxy test in tests/llm/chat.test.ts builds undici's EnvHttpProxyAgent, which otherwise warns that it is experimental on every run.
    execArgv: ['--disable-warning=UNDICI-EHPA'],
  }
});
