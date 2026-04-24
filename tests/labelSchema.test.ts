import { buildAnalysisResultSchema } from '../src/analysis';

function getOperationSchemaWithProperty<T extends string>(schema: ReturnType<typeof buildAnalysisResultSchema>, propertyName: T) {
  const operationSchema = schema.properties.operations.items.anyOf.find(
    candidate => propertyName in candidate.properties
  );

  if (!operationSchema || !(propertyName in operationSchema.properties)) {
    throw new Error(`Expected operation schema with property ${propertyName}`);
  }

  return operationSchema.properties[propertyName];
}

describe('buildAnalysisResultSchema', () => {
  it('creates schema with label enum when repository labels are provided', () => {
    const repoLabels = [
      { name: 'breaking change', description: 'Breaking change' },
      { name: 'awaiting triage', description: 'Needs triage' },
      { name: 'bug', description: null },
    ];

    const schema = buildAnalysisResultSchema(repoLabels);
    const labelsSchema = getOperationSchemaWithProperty(schema, 'labels');

    expect(labelsSchema.items).toHaveProperty('enum');
    expect(labelsSchema.items.enum).toEqual([
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
    const labelsSchema = getOperationSchemaWithProperty(schema, 'labels');

    expect(labelsSchema.items.enum).toEqual([
      'good first issue',
      'help wanted',
    ]);
  });

  it('falls back to unconstrained schema when no labels provided', () => {
    const schema = buildAnalysisResultSchema([]);
    const labelsSchema = getOperationSchemaWithProperty(schema, 'labels');

    expect(labelsSchema.items).not.toHaveProperty('enum');
    expect(labelsSchema.items.type).toBe('STRING');
  });

  it('preserves other schema properties', () => {
    const repoLabels = [{ name: 'test', description: null }];
    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.type).toBe('OBJECT');
    expect(schema.required).toEqual(['summary', 'operations']);
    expect(schema.properties.summary).toEqual({ type: 'STRING' });
    expect(schema.properties.operations.type).toBe('ARRAY');
    expect(schema.properties.operations.items.anyOf).toHaveLength(4);
    expect(getOperationSchemaWithProperty(schema, 'body')).toEqual({ type: 'STRING' });
    expect(getOperationSchemaWithProperty(schema, 'state')).toEqual({
      type: 'STRING',
      enum: ['open', 'completed', 'not_planned'],
    });
    expect(getOperationSchemaWithProperty(schema, 'title')).toEqual({ type: 'STRING' });
  });
});
