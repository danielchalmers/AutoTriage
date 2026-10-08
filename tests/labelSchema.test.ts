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

function isStringItemSchema(value: unknown): value is { type: string; enum?: string[] } {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function getLabelItems(schema: ReturnType<typeof buildAnalysisResultSchema>): { type: string; enum?: string[] } {
  const labelOperationSchema = findOperationSchema(schema, 'labels');
  if (!('labels' in labelOperationSchema.properties)) {
    throw new Error('Expected labels property');
  }
  if (!isStringItemSchema(labelOperationSchema.properties.labels.items)) {
    throw new Error('Expected string label item schema');
  }
  return labelOperationSchema.properties.labels.items;
}

describe('buildAnalysisResultSchema', () => {
  it('creates schema with label enum when repository labels are provided', () => {
    const repoLabels = [
      { name: 'breaking change', description: 'Breaking change' },
      { name: 'awaiting triage', description: 'Needs triage' },
      { name: 'bug', description: null },
    ];

    const schema = buildAnalysisResultSchema(repoLabels);
    const labelItems = getLabelItems(schema);

    expect(labelItems).toHaveProperty('enum');
    expect(labelItems.enum).toEqual([
      'awaiting triage',
      'breaking change',
      'bug',
    ]);
  });

  it('falls back to unconstrained schema when no labels provided', () => {
    const schema = buildAnalysisResultSchema([]);
    const labelItems = getLabelItems(schema);

    expect(labelItems).not.toHaveProperty('enum');
    expect(labelItems.type).toBe('string');
  });

  it('preserves other schema properties', () => {
    const repoLabels = [{ name: 'test', description: null }];
    const schema = buildAnalysisResultSchema(repoLabels);

    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['summary', 'operations']);
    expect(schema.properties.summary).toEqual({ type: 'string' });
    expect(schema.properties.operations.type).toBe('array');
    expect(schema.properties.operations.items.anyOf).toHaveLength(4);
    const commentOperationSchema = findOperationSchema(schema, 'body');
    if (!('body' in commentOperationSchema.properties)) {
      throw new Error('Expected body property');
    }
    expect(commentOperationSchema.properties.body).toEqual({ type: 'string' });

    const stateOperationSchema = findOperationSchema(schema, 'state');
    if (!('state' in stateOperationSchema.properties)) {
      throw new Error('Expected state property');
    }
    expect(stateOperationSchema.properties.state).toEqual({
      type: 'string',
      enum: ['open', 'completed', 'not_planned'],
    });

    const titleOperationSchema = findOperationSchema(schema, 'title');
    if (!('title' in titleOperationSchema.properties)) {
      throw new Error('Expected title property');
    }
    expect(titleOperationSchema.properties.title).toEqual({ type: 'string' });
  });
});

// Chat Completions takes the schema as JSON Schema in strict mode.
describe('analysis schema in strict mode', () => {
  // Every object node, so the strict-mode rules can be checked on each.
  function objectNodes(node: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(node)) return node.flatMap(objectNodes);
    if (node === null || typeof node !== 'object') return [];
    const record = node as Record<string, unknown>;
    return [...(record.type === 'object' ? [record] : []), ...Object.values(record).flatMap(objectNodes)];
  }

  it('closes every object and requires all of its properties', () => {
    const objects = objectNodes(buildAnalysisResultSchema([{ name: 'bug' }]));

    // The result and its four operation variants.
    expect(objects).toHaveLength(5);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as object));
    }
  });

  it('leaves out the label enum for a repository with more labels than strict mode allows', () => {
    const labels = Array.from({ length: 251 }, (_, i) => ({ name: 'label-' + i }));

    expect(getLabelItems(buildAnalysisResultSchema(labels.slice(0, 250))).enum).toHaveLength(250);
    expect(getLabelItems(buildAnalysisResultSchema(labels))).toEqual({ type: 'string' });
  });
});
