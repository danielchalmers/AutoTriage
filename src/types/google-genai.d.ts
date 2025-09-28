declare module '@google/genai' {
  export interface GenerateContentParameters {
    model: string;
    contents: Array<{
      role: string;
      parts: Array<{
        text?: string;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>;
    config?: {
      systemInstruction?: string;
      responseMimeType?: string;
      responseSchema?: unknown;
      temperature?: number;
      thinkingConfig?: {
        thinkingBudget?: number;
        includeThoughts?: boolean;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  export class GoogleGenAI {
    constructor(options: { apiKey: string });
    models: {
      generateContent(params: GenerateContentParameters): Promise<any>;
    };
  }
}
