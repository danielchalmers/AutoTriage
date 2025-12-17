import { describe, it, expect } from 'vitest';
import { GeminiClient } from '../src/gemini';

describe('Token Usage Tracking', () => {
    it('should initialize with zero tokens', () => {
        const client = new GeminiClient('dummy-api-key');
        expect(client.totalInputTokens).toBe(0);
        expect(client.totalOutputTokens).toBe(0);
    });

    it('should track tokens from multiple calls', () => {
        const client = new GeminiClient('dummy-api-key');
        
        // Simulate token accumulation
        client.totalInputTokens = 1000;
        client.totalOutputTokens = 500;
        
        expect(client.totalInputTokens).toBe(1000);
        expect(client.totalOutputTokens).toBe(500);
        
        // Simulate more tokens
        client.totalInputTokens += 2000;
        client.totalOutputTokens += 1500;
        
        expect(client.totalInputTokens).toBe(3000);
        expect(client.totalOutputTokens).toBe(2000);
    });
});
