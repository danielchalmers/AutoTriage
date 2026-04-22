/// <reference types="vitest" />
import { buildOperationPlanSchema } from '../src/analysis';

describe('buildOperationPlanSchema', () => {
  it('creates label enums for label operations when repository labels are provided', () => {
    const repoLabels = [
      { name: 'breaking change', description: 'Breaking change' },
      { name: 'awaiting triage', description: 'Needs triage' },
      { name: 'bug', description: null },
    ];

    const schema = buildOperationPlanSchema(repoLabels);
    const [addLabels, removeLabels] = schema.properties.operations.items.anyOf;

    expect(addLabels.properties.labels.items.enum).toEqual([
      'breaking change',
      'awaiting triage',
      'bug',
    ]);
    expect(removeLabels.properties.labels.items.enum).toEqual([
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

    const schema = buildOperationPlanSchema(repoLabels);
    const [addLabels] = schema.properties.operations.items.anyOf;

    expect(addLabels.properties.labels.items.enum).toEqual([
      'help wanted',
      'good first issue',
    ]);
  });

  it('falls back to unconstrained label strings when no labels are provided', () => {
    const schema = buildOperationPlanSchema([]);
    const [addLabels] = schema.properties.operations.items.anyOf;

    expect(addLabels.properties.labels.items).not.toHaveProperty('enum');
    expect(addLabels.properties.labels.items.type).toBe('STRING');
  });

  it('requires summary and operations and preserves operation enums', () => {
    const schema = buildOperationPlanSchema([{ name: 'test', description: null }]);
    const [, , commentOp, stateOp, titleOp] = schema.properties.operations.items.anyOf;

    expect(schema.type).toBe('OBJECT');
    expect(schema.required).toEqual(['summary', 'operations']);
    expect(schema.properties.summary).toEqual({ type: 'STRING' });
    expect(commentOp).toMatchObject({
      properties: {
        kind: { type: 'STRING', enum: ['comment'] },
        body: { type: 'STRING' },
        authorization: { type: 'STRING' },
      },
      required: ['kind', 'body', 'authorization'],
    });
    expect(stateOp.properties.state).toEqual({
      type: 'STRING',
      enum: ['open', 'completed', 'not_planned'],
    });
    expect(titleOp).toMatchObject({
      properties: {
        kind: { type: 'STRING', enum: ['set_title'] },
        title: { type: 'STRING' },
        authorization: { type: 'STRING' },
      },
      required: ['kind', 'title', 'authorization'],
    });
  });
});
