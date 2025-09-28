import { describe, it, expect } from 'vitest';

describe('Gemini (real API)', () => {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = 'gemini-flash-latest';

    if (!apiKey) {
        console.warn('GEMINI_API_KEY environment variable must be set to run Gemini tests. Skipping Gemini tests.');
        it.skip('requires GEMINI_API_KEY to run Gemini integration tests', () => undefined);
        return;
    }

    it('generateJson returns a typed object', async () => {
        interface User { name: string; age: number }
        const { GeminiClient, buildJsonPayload } = await import('../src/gemini');
        const client = new GeminiClient(apiKey);
        const schema = {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING' },
                age: { type: 'NUMBER' },
            },
            required: ['name', 'age'],
        } as const;
        const systemPrompt = 'You are a data generator that outputs only JSON matching the provided schema.';
        const userPrompt = 'Return exactly this JSON object: {"name":"Alice","age":30}';
        const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, 0, -1);
        const result = await client.generateJson<User>(payload, 2, 500);
        expect(result.result).toEqual({ name: 'Alice', age: 30 });
        expect(Array.isArray(result.thoughts)).toBe(true);
    }, 5000);
});
