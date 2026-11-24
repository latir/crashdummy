import type { Finding } from '../../types.js';

/** A gate finding: fails the check regardless of score. Gates carry no penalty. */
export function gateFinding(
  ruleId: string,
  file: string,
  rest: Pick<Finding, 'message'> & Partial<Pick<Finding, 'loc' | 'hint' | 'severity' | 'gate'>>,
): Finding {
  const finding: Finding = {
    ruleId,
    layer: 'integrity',
    gate: rest.gate ?? true,
    evidence: 'strong',
    severity: rest.severity ?? 'error',
    file,
    message: rest.message,
    penalty: 0,
  };
  if (rest.loc) finding.loc = rest.loc;
  if (rest.hint) finding.hint = rest.hint;
  return finding;
}

/** `'a'`, `'a', 'b'`, `'a', 'b' (+3 more)`. Keeps messages short. */
export function listIds(ids: readonly string[], max = 3): string {
  const shown = ids
    .slice(0, max)
    .map((id) => `'${id}'`)
    .join(', ');
  return ids.length > max ? `${shown} (+${ids.length - max} more)` : shown;
}
