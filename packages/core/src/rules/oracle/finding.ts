import type { Finding } from '../../types.js';
import type { OracleRule } from './types.js';

/** A finding for `rule`, with its penalty, gate and severity taken from the rule's metadata. */
export function oracleFinding(
  rule: Pick<OracleRule, 'id' | 'meta'>,
  file: string,
  rest: Pick<Finding, 'message' | 'hint'> & Partial<Pick<Finding, 'loc' | 'severity'>>,
): Finding {
  const finding: Finding = {
    ruleId: rule.id,
    layer: 'oracle',
    gate: rule.meta.gate,
    evidence: rule.meta.evidence,
    severity: rest.severity ?? rule.meta.severity,
    file,
    message: rest.message,
    penalty: rule.meta.penalty,
  };
  if (rest.hint) finding.hint = rest.hint;
  if (rest.loc) finding.loc = rest.loc;
  return finding;
}

/** A test that never runs cannot be judged here: skipping it is the integrity layer's concern. */
export const isDisabled = (modifier: string | undefined): boolean =>
  modifier === 'skip' || modifier === 'todo' || modifier === 'fixme';
