import { integrityRules } from '../rules/integrity/index.js';
import { oracleRules } from '../rules/oracle/index.js';
import type { UnknownMatcher } from '../types.js';

interface Doc {
  /** Why the rule exists. */
  principle: string;
  /** What the research says, in a sentence. */
  evidence: string;
  /** A short before and after. */
  bad: string;
  good: string;
}

const MUTATION =
  'A test that cannot fail when the code is wrong adds cost without protection (Barr et al., TSE 2015: a test needs a real oracle).';

const DOCS: Record<string, Doc> = {
  'oracle/no-assertion': {
    principle: 'A test that checks nothing passes whatever the code does.',
    evidence: MUTATION,
    bad: "test('adds', () => {\n  add(1, 2);\n});",
    good: "test('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});",
  },
  'oracle/tautological-assertion': {
    principle:
      'An assertion where both sides are written in the test, or a value is compared with itself, cannot fail.',
    evidence: MUTATION,
    bad: 'expect(true).toBe(true);\nexpect(cart).toBe(cart);',
    good: 'expect(cart.total).toBe(30);',
  },
  'oracle/swallowed-async': {
    principle:
      'An asynchronous assertion nothing waits for can fail after the test has already passed.',
    evidence: 'Strong: the failure is lost, so the test passes whatever the assertion finds.',
    bad: "test('loads', () => {\n  expect(load()).resolves.toBe(1);\n});",
    good: "test('loads', async () => {\n  await expect(load()).resolves.toBe(1);\n});",
  },
  'oracle/mocks-subject': {
    principle: 'If the test replaces the module it is testing, it checks the replacement.',
    evidence:
      'Moderate to strong. A partial mock (the factory spreads the real module) only warns. Both are warnings until precision is measured.',
    bad: "vi.mock('./cart');  // in cart.test.ts",
    good: "vi.mock('./tax');   // mock what cart depends on, not cart",
  },
  'oracle/tautological-mock': {
    principle: 'Setting a mock to return X and asserting that X comes back checks the mock.',
    evidence: 'Moderate. Matched by name inside one file, so it is a warning.',
    bad: 'const price = vi.fn().mockReturnValue(42);\nexpect(price()).toBe(42);',
    good: 'vi.mocked(api.price).mockReturnValue(42);\nexpect(checkout().total).toBe(42);',
  },
  'oracle/weak-matcher': {
    principle: 'A value that is only checked for existing is not checked for being right.',
    evidence:
      'Moderate. A warning until precision is measured. A stronger assertion on the same value excuses it.',
    bad: 'expect(cart).toBeTruthy();',
    good: 'expect(cart).toEqual({ items: [], total: 0 });',
  },
  'oracle/interaction-only': {
    principle:
      'Checking only that a function was called says nothing about the result it produced.',
    evidence: 'Moderate. Quiet when the test never captures a result (code that returns nothing).',
    bad: 'const receipt = checkout(pay);\nexpect(pay).toHaveBeenCalled();',
    good: 'const receipt = checkout(pay);\nexpect(pay).toHaveBeenCalled();\nexpect(receipt.total).toBe(10);',
  },
  'integrity/test-removed': {
    principle: 'Deleting a test removes a check. Agents often do it to get to green.',
    evidence:
      'Strong: in ImpossibleBench (ICLR 2026) models often reached green by editing the tests.',
    bad: '// the test is gone',
    good: '// restore it, or: // crashdummy-allow integrity/test-removed: <reason>',
  },
  'integrity/modifier-added': {
    principle: 'A new `.skip`, `.only`, `fixme` or `todo` silently turns tests off.',
    evidence: 'Strong (ImpossibleBench, ICLR 2026).',
    bad: "test.skip('adds', () => { /* ... */ });",
    good: "test('adds', () => { /* ... */ });",
  },
  'integrity/matcher-weakened': {
    principle: 'Moving an assertion down the strength lattice makes the test pass more easily.',
    evidence: 'Strong (ImpossibleBench, ICLR 2026). See docs/matchers.md for the lattice.',
    bad: 'expect(cart).toBeTruthy();   // was toEqual({ ... })',
    good: 'expect(cart).toEqual({ items: [], total: 0 });',
  },
  'integrity/assertions-dropped': {
    principle: 'A test that still exists but checks less than before has been weakened.',
    evidence: 'Strong (ImpossibleBench, ICLR 2026). Adding assertions is never rewarded.',
    bad: '// two expect() calls became one',
    good: '// restore the assertion, or: // crashdummy-allow integrity/assertions-dropped: <reason>',
  },
  'integrity/unparseable': {
    principle: 'A file with a syntax error cannot be checked. It is never scored as 0 or 100.',
    evidence: 'Not a statistical rule: the parser does not recover from syntax errors.',
    bad: "test('adds', () => {",
    good: "test('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});",
  },
  'integrity/unparseable-before': {
    principle: 'The old version of the file had a syntax error, so it cannot be compared.',
    evidence: 'Not a statistical rule.',
    bad: '// the base version does not parse',
    good: '// fix the syntax error in the base, or accept that nothing can be compared',
  },
  'integrity/allow-without-reason': {
    principle: 'An override must say why. A bare `crashdummy-allow` allows nothing.',
    evidence: 'Every suppression needs a reason, so it can be reviewed later.',
    bad: '// crashdummy-allow integrity/modifier-added',
    good: '// crashdummy-allow integrity/modifier-added: flaky on CI, tracked in the issue tracker',
  },
  'integrity/allow-unknown-rule': {
    principle: 'An override names a rule that does not exist, so it allows nothing.',
    evidence: 'A typo would otherwise hide the gate it was meant to allow.',
    bad: '// crashdummy-allow integrity/modifer-added: reason',
    good: '// crashdummy-allow integrity/modifier-added: reason',
  },
  'info/unknown-matcher': {
    principle:
      'A matcher the strength lattice does not know is scored as neutral, so a gap there is silent unless it is shown.',
    evidence: 'Informational. It never changes a score or a verdict.',
    bad: 'expect(x).toBeWithinRange(1, 2);   // not in the lattice',
    good: '// config: { "matchers": { "toBeWithinRange": { "strength": 3 } } }',
  },
};

/** Every rule id that has an explanation. */
export const explainableRules = (): string[] => Object.keys(DOCS).sort();

/** What a rule catches, the evidence behind it and an example fix. Undefined for an unknown id. */
export function explainRule(id: string): string | undefined {
  // own keys only: `constructor` and `__proto__` are not rules
  const doc = Object.prototype.hasOwnProperty.call(DOCS, id) ? DOCS[id] : undefined;
  if (!doc) return undefined;
  const meta = [...oracleRules, ...integrityRules].find((r) => r.id === id)?.meta;
  const indent = (code: string): string =>
    code
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
  return [
    id,
    '',
    meta ? meta.summary : doc.principle,
    '',
    `Why: ${doc.principle}`,
    `Evidence${meta ? ` (${meta.evidence})` : ''}: ${doc.evidence}`,
    '',
    'Instead of:',
    indent(doc.bad),
    'write:',
    indent(doc.good),
  ].join('\n');
}

/** The matchers the lattice did not recognise, with a config snippet to paste. */
export function explainMatchers(unknown: readonly UnknownMatcher[]): string {
  if (unknown.length === 0) return 'Every matcher in the checked files is in the strength lattice.';
  const lines = unknown.map(
    (m) => `  ${m.name}  ${m.count} use${m.count === 1 ? '' : 's'} in ${m.files.join(', ')}`,
  );
  const snippet = Object.fromEntries(unknown.map((m) => [m.name, { strength: 3 }]));
  return [
    `${unknown.length} matcher${unknown.length === 1 ? '' : 's'} not in the strength lattice (scored as neutral):`,
    ...lines,
    '',
    'Add them to .crashdummy/config.json, with the strength each one deserves (1 weakest, 4 strongest):',
    JSON.stringify({ matchers: snippet }, null, 2),
  ].join('\n');
}
