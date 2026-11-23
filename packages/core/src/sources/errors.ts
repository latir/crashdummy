/** A change source could not do its job (no git repo, unknown base, unreadable file). */
export class SourceError extends Error {
  override name = 'SourceError';
}
