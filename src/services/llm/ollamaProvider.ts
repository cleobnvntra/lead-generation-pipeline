import { z } from 'zod';
import { ConfigError, ExternalApiError, ValidationError } from '../../lib/errors.ts';
import type { JsonRequest, JsonResponse, LlmProvider } from './types.ts';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  numCtx: number;
}

const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
});

const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });

const MAX_ATTEMPTS = 2;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;

  constructor(private readonly opts: OllamaOptions) {
    if (!opts.model) throw new ConfigError('Ollama model is required');
    this.model = opts.model;
  }

  async healthCheck(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new ConfigError(`Ollama is not reachable at ${this.opts.baseUrl}. Start the Ollama app (or run "ollama serve").`);
    }
    if (!res.ok) throw new ConfigError(`Ollama at ${this.opts.baseUrl} returned HTTP ${res.status}.`);
    const parsed = tagsSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ConfigError('Unexpected response from Ollama /api/tags.');

    const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
    if (!parsed.data.models.some((m) => m.name === wanted)) {
      const have = parsed.data.models.map((m) => m.name).join(', ') || 'none';
      throw new ConfigError(`Model "${this.model}" is not installed (installed: ${have}). Run: ollama pull ${this.model}`);
    }
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    if (!req.system.trim() || !req.user.trim()) throw new ValidationError('system and user prompts are required');
    const temperature = req.temperature ?? 0;
    if (!(temperature >= 0 && temperature <= 2)) throw new ValidationError('temperature must be 0-2');

    const format = z.toJSONSchema(req.schema, { target: 'draft-7', io: 'output' });
    const messages: ChatMessage[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];
    const started = Date.now();
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const content = await this.chat(messages, format, temperature);
      const result = parseAndValidate(content, req.schema);
      if (result.ok) {
        return { data: result.data, model: this.model, attempts: attempt, durationMs: Date.now() - started };
      }
      lastError = result.error;
      messages.push(
        { role: 'assistant', content: content.slice(0, 4000) },
        { role: 'user', content: `That output was invalid: ${result.error}. Return corrected JSON only.` },
      );
    }
    throw new ExternalApiError(`Model output failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`, 200);
  }

  private async chat(messages: ChatMessage[], format: unknown, temperature: number): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          format,
          stream: false,
          think: false, // qwen3: skip the reasoning trace; schema-constrained output is enough here
          options: { temperature, num_ctx: this.opts.numCtx },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? `timed out after ${this.opts.timeoutMs} ms` : (err as Error).message;
      throw new ExternalApiError(`Ollama request failed: ${msg}`, 0);
    }
    const text = await res.text();
    if (!res.ok) throw new ExternalApiError(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ExternalApiError('Ollama returned non-JSON response', res.status);
    }
    const parsed = chatResponseSchema.safeParse(json);
    if (!parsed.success) throw new ExternalApiError('Unexpected Ollama /api/chat response shape', res.status);
    if (parsed.data.done_reason === 'length') {
      throw new ExternalApiError('Model output was cut off (context too small). Increase LLM_NUM_CTX.', res.status);
    }
    return parsed.data.message.content;
  }
}

export function parseAndValidate<T>(content: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    error: r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}
