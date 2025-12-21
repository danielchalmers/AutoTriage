/// <reference types="vitest" />
import { buildAnalysisResultSchema } from '../src/analysis';

describe('buildAnalysisResultSchema', () => {
  it('creates schema with label enum when repository labels are provided', () => {
    const repoLabels = [
      { name: 'breaking change', description: 'Breaking change' },
      { name: 'awaiting triage', description: 'Needs triage' },
      { name: 'bug', description: null },
    ];

    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.properties.labels.items).toHaveProperty('enum');
    expect(schema.properties.labels.items.enum).toEqual([
      'breaking change',
      'awaiting triage',
      'bug',
    ]);
  });

  it('handles labels with spaces correctly', () => {
    const repoLabels = [
      { name: 'help wanted', description: 'Help wanted' },
      { name: 'good first issue', description: 'Good for newcomers' },
    ];

    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.properties.labels.items.enum).toEqual([
      'help wanted',
      'good first issue',
    ]);
  });

  it('falls back to unconstrained schema when no labels provided', () => {
    const schema = buildAnalysisResultSchema([]);

    expect(schema.properties.labels.items).not.toHaveProperty('enum');
    expect(schema.properties.labels.items.type).toBe('STRING');
  });

  it('preserves other schema properties', () => {
    const repoLabels = [{ name: 'test', description: null }];
    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.type).toBe('OBJECT');
    expect(schema.required).toEqual(['summary', 'labels']);
    expect(schema.properties.summary).toEqual({ type: 'STRING' });
    expect(schema.properties.comment).toEqual({ type: 'STRING' });
    expect(schema.properties.state).toEqual({
      type: 'STRING',
      enum: ['open', 'completed', 'not_planned'],
    });
    expect(schema.properties.newTitle).toEqual({ type: 'STRING' });
  });
});
