import type { z } from 'zod';

export interface JsonRequest<T> {
  /** Instructions. Must not contain untrusted text. */
  system: string;
  /** Task input. May contain untrusted text (web pages); the schema check is the guardrail. */
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
}

export interface JsonResponse<T> {
  data: T;
  model: string;
  attempts: number;
  durationMs: number;
}

/** Provider-agnostic LLM interface. Add Claude etc. by implementing this. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Throws a clear error if the provider is unreachable or the model is missing. */
  healthCheck(): Promise<void>;
  /** Returns schema-validated JSON; retries once with the validation error, then throws. */
  generateJson<T>(req: JsonRequest<T>): Promise<JsonResponse<T>>;
}
