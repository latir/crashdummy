import type { ParseDiagnostic } from './parse/oxc.js';

/** The user's config is invalid. The message names the offending key. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * A file could not be parsed. oxc does not recover from syntax errors: there is no AST, so no
 * test information. Callers must treat the file as "unknown", never as "has no tests".
 */
export class ParseError extends Error {
  override name = 'ParseError';

  constructor(
    readonly path: string,
    readonly errors: readonly ParseDiagnostic[],
  ) {
    const first = errors[0];
    super(first ? `${path}:${first.line}:${first.col}: ${first.message}` : `${path}: syntax error`);
  }
}
