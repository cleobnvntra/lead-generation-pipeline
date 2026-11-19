import { getEnv } from '../../config/env.ts';
import { OllamaProvider } from './ollamaProvider.ts';
import type { LlmProvider } from './types.ts';

export type { LlmProvider } from './types.ts';

/** Builds the configured provider. Switching to Claude later = new provider class + LLM_PROVIDER value. */
export function createLlmProvider(): LlmProvider {
  const env = getEnv();
  switch (env.LLM_PROVIDER) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_MODEL,
        timeoutMs: env.LLM_TIMEOUT_MS,
        numCtx: env.LLM_NUM_CTX,
      });
  }
}
