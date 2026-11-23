/** The user's config is invalid. The message names the offending key. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}
