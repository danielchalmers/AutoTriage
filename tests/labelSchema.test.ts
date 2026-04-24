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
    const labelOperationSchema = schema.properties.operations.items.anyOf[0];

    expect(labelOperationSchema.properties.labels.items).toHaveProperty('enum');
    expect(labelOperationSchema.properties.labels.items.enum).toEqual([
      'awaiting triage',
      'breaking change',
      'bug',
    ]);
  });

  it('handles labels with spaces correctly', () => {
    const repoLabels = [
      { name: 'help wanted', description: 'Help wanted' },
      { name: 'good first issue', description: 'Good for newcomers' },
    ];

    const schema = buildAnalysisResultSchema(repoLabels);
    const labelOperationSchema = schema.properties.operations.items.anyOf[0];

    expect(labelOperationSchema.properties.labels.items.enum).toEqual([
      'good first issue',
      'help wanted',
    ]);
  });

  it('falls back to unconstrained schema when no labels provided', () => {
    const schema = buildAnalysisResultSchema([]);
    const labelOperationSchema = schema.properties.operations.items.anyOf[0];

    expect(labelOperationSchema.properties.labels.items).not.toHaveProperty('enum');
    expect(labelOperationSchema.properties.labels.items.type).toBe('STRING');
  });

  it('preserves other schema properties', () => {
    const repoLabels = [{ name: 'test', description: null }];
    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.type).toBe('OBJECT');
    expect(schema.required).toEqual(['summary', 'operations']);
    expect(schema.properties.summary).toEqual({ type: 'STRING' });
    expect(schema.properties.operations.type).toBe('ARRAY');
    expect(schema.properties.operations.items.anyOf).toHaveLength(4);
    expect(schema.properties.operations.items.anyOf[1].properties.body).toEqual({ type: 'STRING' });
    expect(schema.properties.operations.items.anyOf[2].properties.state).toEqual({
      type: 'STRING',
      enum: ['open', 'completed', 'not_planned'],
    });
    expect(schema.properties.operations.items.anyOf[3].properties.title).toEqual({ type: 'STRING' });
  });
});
