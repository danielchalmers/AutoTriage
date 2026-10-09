import { beforeEach } from 'vitest';

// On a GitHub runner these variables describe the CI job itself, such as its inputs and the push event's payload, and would otherwise leak into the code under test.
function clearRunnerEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (/^(GITHUB|INPUT|RUNNER)_/.test(name)) delete process.env[name];
  }
}

// Clearing them before the test file loads matters too, because @actions/github reads the event payload once, when it is first imported.
clearRunnerEnvironment();
beforeEach(clearRunnerEnvironment);
