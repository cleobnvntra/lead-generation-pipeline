import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ValidationError } from './errors.ts';

/**
 * Opens an http(s) URL in the default browser, or an existing local file/folder with its default app.
 * No shell is involved, so the target can't inject commands.
 */
export function openExternal(target: string): void {
  const isUrl = /^https?:\/\//i.test(target);
  if (isUrl) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new ValidationError(`Not a valid URL: ${target}`);
    }
    target = url.href;
  } else if (!existsSync(target)) {
    throw new ValidationError(`File not found: ${target}`);
  }

  // Windows: explorer.exe silently ignores long URLs with query strings (e.g. Google sign-in links), so web links
  // go through the URL protocol handler; files and folders still open in Explorer. No shell either way.
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? isUrl
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
        : ['explorer.exe', [target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined); // best effort; caller shows the path anyway
  child.unref();
}
