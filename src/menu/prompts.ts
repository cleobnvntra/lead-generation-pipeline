import { input } from '@inquirer/prompts';
import pc from 'picocolors';
import { ConfigError, ExternalApiError, LimitError, ValidationError } from '../lib/errors.ts';
import { bad, warn } from '../views/ui.ts';

/** Ctrl+C inside any prompt. */
export function isExitPrompt(err: unknown): boolean {
  return err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError');
}

export async function pause(message = 'Press Enter to go back'): Promise<void> {
  await input({ message: pc.dim(message), theme: { prefix: '' } });
}

/** Explains an error in plain language. Unknown errors keep their message so they can be reported. */
export function explainError(err: unknown): string {
  if (err instanceof ConfigError) {
    if (/GOOGLE_PLACES_API_KEY/.test(err.message)) {
      return bad('The Google Places key is missing. Add it to the .env file (see .env.example), then try again.');
    }
    if (/Ollama is not reachable/.test(err.message)) {
      return bad('The AI model is not running. Open the Ollama app, wait a few seconds, then try again.');
    }
    if (/is not installed/.test(err.message)) return bad(`The AI model isn't downloaded yet. ${err.message.replace(/^.*Run: /, 'Run: ')}`);
    return bad(err.message);
  }
  if (err instanceof LimitError) return warn(`Stopped to protect your free Google quota: ${err.message}`);
  if (err instanceof ValidationError) return bad(err.message);
  if (err instanceof ExternalApiError) return bad(`An outside service returned an error: ${err.message}`);
  return bad(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
}

/** Runs one menu action; shows friendly errors instead of crashing. Ctrl+C is passed up. */
export async function guarded(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (isExitPrompt(err)) throw err;
    console.log(`\n${explainError(err)}`);
    await pause();
  }
}
