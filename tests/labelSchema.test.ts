import { buildAnalysisResultSchema } from '../src/analysis';

function findOperationSchema(schema: ReturnType<typeof buildAnalysisResultSchema>, propertyName: string) {
  const operationSchema = schema.properties.operations.items.anyOf.find(
    candidate => propertyName in candidate.properties
  );

  if (!operationSchema) {
    throw new Error(`Expected operation schema with property ${propertyName}`);
  }

  return operationSchema;
}

describe('buildAnalysisResultSchema', () => {
  it('creates schema with label enum when repository labels are provided', () => {
    const repoLabels = [
      { name: 'breaking change', description: 'Breaking change' },
      { name: 'awaiting triage', description: 'Needs triage' },
      { name: 'bug', description: null },
    ];

    const schema = buildAnalysisResultSchema(repoLabels);
    const labelOperationSchema = findOperationSchema(schema, 'labels');
    if (!('labels' in labelOperationSchema.properties)) {
      throw new Error('Expected labels property');
    }
    const labelItems = labelOperationSchema.properties.labels.items as { type: string; enum?: string[] };

    expect(labelItems).toHaveProperty('enum');
    expect(labelItems.enum).toEqual([
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
    const labelOperationSchema = findOperationSchema(schema, 'labels');
    if (!('labels' in labelOperationSchema.properties)) {
      throw new Error('Expected labels property');
    }
    const labelItems = labelOperationSchema.properties.labels.items as { type: string; enum?: string[] };

    expect(labelItems.enum).toEqual([
      'good first issue',
      'help wanted',
    ]);
  });

  it('falls back to unconstrained schema when no labels provided', () => {
    const schema = buildAnalysisResultSchema([]);
    const labelOperationSchema = findOperationSchema(schema, 'labels');
    if (!('labels' in labelOperationSchema.properties)) {
      throw new Error('Expected labels property');
    }
    const labelItems = labelOperationSchema.properties.labels.items as { type: string; enum?: string[] };

    expect(labelItems).not.toHaveProperty('enum');
    expect(labelItems.type).toBe('STRING');
  });

  it('preserves other schema properties', () => {
    const repoLabels = [{ name: 'test', description: null }];
    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.type).toBe('OBJECT');
    expect(schema.required).toEqual(['summary', 'operations']);
    expect(schema.properties.summary).toEqual({ type: 'STRING' });
    expect(schema.properties.operations.type).toBe('ARRAY');
    expect(schema.properties.operations.items.anyOf).toHaveLength(4);
    const commentOperationSchema = findOperationSchema(schema, 'body');
    if (!('body' in commentOperationSchema.properties)) {
      throw new Error('Expected body property');
    }
    expect(commentOperationSchema.properties.body).toEqual({ type: 'STRING' });

    const stateOperationSchema = findOperationSchema(schema, 'state');
    if (!('state' in stateOperationSchema.properties)) {
      throw new Error('Expected state property');
    }
    expect(stateOperationSchema.properties.state).toEqual({
      type: 'STRING',
      enum: ['open', 'completed', 'not_planned'],
    });

    const titleOperationSchema = findOperationSchema(schema, 'title');
    if (!('title' in titleOperationSchema.properties)) {
      throw new Error('Expected title property');
    }
    expect(titleOperationSchema.properties.title).toEqual({ type: 'STRING' });
  });
});
