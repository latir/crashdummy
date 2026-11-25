import type { AstNode } from './ast.js';

/**
 * What a rule can see about one assertion. Built while the summary is, so rules never redo its
 * scope, helper and mock tracking. It carries the syntax node, so a rule can look at the code
 * around the assertion itself. Never stored: it is not part of `TestSummary`.
 */
export interface AssertionFact {
  /** The call that asserts: `expect(x).toBe(1)`, `assert.equal(a, b)`, `check(x)`. */
  node: AstNode;
  loc: { line: number; col: number };
  /** Matcher or assert method name, as in `MatcherUse.name`. */
  matcher: string;
  strength: 1 | 2 | 3 | 4;
  negated: boolean;
  /** The value being checked, if the assertion has one. */
  subject: AstNode | undefined;
  /** Source text of the subject, for telling whether two assertions check the same thing. */
  subjectText: string | undefined;
  subjectIsMock: boolean;
  /** Reached by following a local helper, not written in the test itself. */
  viaHelper: boolean;
  /** The matcher is in the strength lattice, so what it checks is known. */
  known: boolean;
  /** A function named in `assertFunctionNames`. What it checks is up to the helper. */
  custom: boolean;
}

/** One test, with the detail rules need. Same order as `TestSummary.tests`. */
export interface TestFacts {
  /** Same id as the matching `TestCase`. */
  id: string;
  loc: { line: number; col: number };
  modifier?: 'skip' | 'only' | 'todo' | 'fixme' | 'fails';
  /** The body of an inline test callback. Absent for `test('x', namedFn)`. */
  body?: AstNode;
  /** The test callback itself, so a rule can see its parameters and whether it is async. */
  fn?: AstNode;
  assertions: AssertionFact[];
}

/** A `vi.mock('./x', factory?)` or `jest.mock(...)` that takes effect when the file runs. */
export interface ModuleMock {
  /** The module as written, before resolution. */
  spec: string;
  loc: { line: number; col: number };
  node: AstNode;
  /** The factory function. Absent for an automock: `vi.mock('./x')`. */
  factory?: AstNode;
}
