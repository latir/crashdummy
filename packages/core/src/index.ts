/** Placeholder until the engine lands. */
export const name = '@crashdummy/core';

export * from './rules/index.js';
export * from './sources/index.js';
export { ConfigError, ParseError } from './errors.js';
export type * from './types.js';
export * from './parse/index.js';
export * from './score/index.js';
export { loadConfig, parseConfig, type Config } from './config.js';
