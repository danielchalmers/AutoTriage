/// <reference types="vitest" />
import { parseAnalysisResult } from '../src/analysis';

describe('parseAnalysisResult', () => {
  it('returns a schema-valid reply unchanged', () => {
    const reply = { operations: [{ kind: 'comment', body: 'Hello', authorization: 'auth' }], summary: 's' };

    expect(JSON.stringify(parseAnalysisResult(reply))).toBe(JSON.stringify(reply));
  });

  it('rejects replies that are not an object with an operations array', () => {
    for (const reply of [null, 'text', 42, [], {}, { summary: 's' }, { summary: 's', operations: {} }]) {
      expect(() => parseAnalysisResult(reply)).toThrow('Model reply is not an object with an operations array');
    }
  });

  it('replaces a missing or non-string summary with an empty string', () => {
    expect(parseAnalysisResult({ operations: [] })).toEqual({ summary: '', operations: [] });
    expect(parseAnalysisResult({ summary: 7, operations: [] })).toEqual({ summary: '', operations: [] });
  });
});
