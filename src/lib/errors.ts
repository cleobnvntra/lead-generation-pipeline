/** Misconfiguration the user must fix (missing key, bad .env value). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Invalid input from the CLI or an external caller. */
export class ValidationError extends Error {
  override name = 'ValidationError';
}

/** A hard limit (quota, budget) would be exceeded. */
export class LimitError extends Error {
  override name = 'LimitError';
}

/** An external HTTP API returned an error. */
export class ExternalApiError extends Error {
  override name = 'ExternalApiError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
