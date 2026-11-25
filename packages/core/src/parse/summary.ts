import { createHash } from 'node:crypto';
import { globToRegExp } from '../sources/testfiles.js';
import type { MatcherUse, TestCase, TestSummary } from '../types.js';
import {
  createLattice,
  type ArgKind,
  type Lattice,
  type MatcherOverrides,
  type MatcherRef,
  type Modifier as ResolveModifier,
} from '../rules/lattice.js';
import {
  child,
  children,
  isFunction,
  isTsValueWrapper,
  isTypeOnly,
  memberPath,
  sourceText,
  staticNumber,
  staticString,
  str,
  unwrap,
  type AstNode,
} from './ast.js';
import type { AssertionFact, ModuleMock, TestFacts } from './facts.js';
import type { Visitor, WalkContext } from './walk.js';

export type TestModifier = NonNullable<TestCase['modifier']>;

export interface SummaryOptions {
  /**
   * Extra function names that count as assertions, such as `expectValid` or `check*`. Matched
   * against the call's dotted path (`helpers.expectValid`); `*` is a wildcard.
   */
  assertFunctionNames?: readonly string[];
  /** User matcher overrides for the strength lattice. */
  matchers?: MatcherOverrides;
}

/** Bump when the summary shape or its derivation changes, so stale caches are ignored. */
export const SUMMARY_VERSION = 6;

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * Maps a call path through the file's imports: `spec` from `import { test as spec }` becomes
 * `test`, and `vitest.test` from `import * as vitest` becomes `test`.
 */
type Norm = (path: string[] | undefined) => string[] | undefined;

// ---------------------------------------------------------------------------------------------
// Declarations: describe / it / test and their modifiers

interface Decl {
  kind: 'describe' | 'test';
  modifiers: TestModifier[];
  nameNode: AstNode;
  fn?: AstNode;
  /** `test('name', runCase)`: the body is a function defined elsewhere in the file. */
  fnRef?: AstNode;
  timeout?: number;
}

const BASES: Record<string, { kind: 'describe' | 'test'; modifier?: TestModifier }> = {
  describe: { kind: 'describe' },
  suite: { kind: 'describe' },
  it: { kind: 'test' },
  test: { kind: 'test' },
  xdescribe: { kind: 'describe', modifier: 'skip' },
  fdescribe: { kind: 'describe', modifier: 'only' },
  xit: { kind: 'test', modifier: 'skip' },
  xtest: { kind: 'test', modifier: 'skip' },
  fit: { kind: 'test', modifier: 'only' },
};

const MODIFIER_WORDS: Record<string, TestModifier> = {
  skip: 'skip',
  only: 'only',
  todo: 'todo',
  fixme: 'fixme',
  fails: 'fails',
  failing: 'fails',
};

/** `.each` / `.for` (table) forms. `skipIf` and `runIf` are conditional, so they set no modifier. */
const TABLE_WORDS = new Set(['each', 'for']);
const CONDITIONAL_WORDS = new Set(['skipIf', 'runIf', 'todoIf']);
const KNOWN_FLAGS = new Set(['concurrent', 'sequential', 'serial', 'parallel', 'slow', 'shuffle']);

/** Find the dotted path of a declaration callee, looking through `.each(table)` and templates. */
function declPath(callee: AstNode, norm: Norm): string[] | undefined {
  const c = unwrap(callee);
  if (c.type === 'TaggedTemplateExpression') {
    const tag = child(c, 'tag');
    return tag ? declPath(tag, norm) : undefined;
  }
  if (c.type === 'CallExpression') {
    const inner = child(c, 'callee');
    const path = inner ? norm(memberPath(inner)) : undefined;
    const last = path?.[path.length - 1];
    if (path && last !== undefined && (TABLE_WORDS.has(last) || CONDITIONAL_WORDS.has(last))) {
      return path;
    }
    return undefined;
  }
  return norm(memberPath(c));
}

function parseDecl(call: AstNode, norm: Norm): Decl | undefined {
  const callee = child(call, 'callee');
  if (!callee) return undefined;
  const path = declPath(callee, norm);
  if (!path) return undefined;

  const base = BASES[path[0] ?? ''];
  if (!base) return undefined;
  let kind = base.kind;
  const modifiers: TestModifier[] = base.modifier ? [base.modifier] : [];
  let segments = path.slice(1);

  // Playwright: test.describe, test.describe.skip, ...
  if (path[0] === 'test' && segments[0] === 'describe') {
    kind = 'describe';
    segments = segments.slice(1);
  }
  for (const word of segments) {
    const mod = MODIFIER_WORDS[word];
    if (mod) modifiers.push(mod);
    else if (!TABLE_WORDS.has(word) && !CONDITIONAL_WORDS.has(word) && !KNOWN_FLAGS.has(word)) {
      return undefined; // for example test.step, test.use, test.beforeEach
    }
  }

  const args = children(call, 'arguments');
  const nameNode = args[0];
  if (!nameNode || isFunction(unwrap(nameNode))) return undefined;
  const fn = args.map(unwrap).find(isFunction);
  // A titled test can name its body: test('adds', addsCase). Needs a string title, so that
  // test.skip(isMobile, 'reason') inside a body is not mistaken for a declaration.
  const fnRef =
    !fn && staticString(nameNode) !== undefined
      ? args
          .slice(1)
          .map(unwrap)
          .find((a) => a.type === 'Identifier')
      : undefined;
  const isTodo = modifiers.includes('todo');
  // `test.skip(condition, 'reason')` inside a body is not a declaration: it needs a body.
  if (!fn && !fnRef && !isTodo) return undefined;

  const decl: Decl = {
    kind,
    modifiers,
    nameNode,
    ...(fn ? { fn } : {}),
    ...(fnRef ? { fnRef } : {}),
  };
  for (const arg of args.slice(1)) {
    const u = unwrap(arg);
    if (u === fn || u === fnRef) continue;
    const n = staticNumber(u);
    if (n !== undefined) decl.timeout = n;
    else if (u.type === 'ObjectExpression') applyOptions(u, decl);
  }
  return decl;
}

/** `{ timeout, skip, only, todo }` option objects (Vitest, Playwright, node:test). */
function applyOptions(obj: AstNode, decl: Decl): void {
  for (const prop of children(obj, 'properties')) {
    if (prop.type !== 'Property') continue;
    const keyNode = child(prop, 'key');
    const value = child(prop, 'value');
    if (!keyNode || !value) continue;
    const key = str(keyNode, 'name') ?? staticString(keyNode);
    if (key === 'timeout') {
      const n = staticNumber(value);
      if (n !== undefined) decl.timeout = n;
      continue;
    }
    const mod = key === undefined ? undefined : MODIFIER_WORDS[key];
    if (!mod) continue;
    const v = unwrap(value);
    const off = v.type === 'Literal' && (v.value === false || v.value === null);
    if (!off) decl.modifiers.push(mod);
  }
}

function pickModifier(mods: readonly TestModifier[]): TestModifier | undefined {
  for (const m of ['skip', 'only', 'todo', 'fixme', 'fails'] as const) {
    if (mods.includes(m)) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Assertions: expect chains, node:assert, custom helpers

const CHAIN_MODS = new Set(['not', 'resolves', 'rejects']);
const EXPECT_ROOTS = new Set(['expect', 'expect.soft', 'expect.poll']);

interface Assertion {
  ref: MatcherRef;
  /** The value being checked, for mock detection. */
  subject: AstNode | undefined;
}

function argKind(arg: AstNode | undefined, norm: Norm): ArgKind {
  if (!arg) return 'none';
  const a = unwrap(arg);
  if (a.type === 'CallExpression') {
    const callee = child(a, 'callee');
    const path = callee ? norm(memberPath(callee)) : undefined;
    if (path?.join('.') === 'expect.anything') return 'anything';
    return 'other';
  }
  if (a.type === 'Literal') return 'regex' in a ? 'other' : 'literal';
  if (a.type === 'TemplateLiteral') {
    return children(a, 'expressions').length === 0 ? 'literal' : 'other';
  }
  if (a.type === 'UnaryExpression') {
    const inner = child(a, 'argument');
    return inner && unwrap(inner).type === 'Literal' ? 'literal' : 'other';
  }
  if (a.type === 'Identifier') {
    const name = str(a, 'name');
    return name === 'undefined' || name === 'NaN' || name === 'Infinity' ? 'literal' : 'other';
  }
  return 'other';
}

const ASSERT_CALLEE_ARG: Record<string, number> = {
  'assert.throws': 1,
  'assert.rejects': 1,
  'assert.doesNotThrow': 1,
  'assert.doesNotReject': 1,
};

/** In strict mode (`node:assert/strict`, `assert.strict`) the loose methods are the strict ones. */
const STRICT_METHODS: Record<string, string> = {
  equal: 'strictEqual',
  notEqual: 'notStrictEqual',
  deepEqual: 'deepStrictEqual',
  notDeepEqual: 'notDeepStrictEqual',
};

const ASSERT_MODULES = new Set(['assert', 'node:assert']);
const ASSERT_STRICT_MODULES = new Set(['assert/strict', 'node:assert/strict']);

/** What a local name stands for when it comes from `node:assert`, by import or by `require`. */
type AssertBinding =
  { kind: 'namespace'; strict: boolean } | { kind: 'named'; imported: string; strict: boolean };

/** The part of a scope binding that the assertion finder needs. */
interface BindingInfo {
  assert?: AssertBinding;
  /** A function parameter. In a `node:test` file one of them is the context: `ctx.assert.equal(...)`. */
  param?: boolean;
  importFrom?: string;
}

class AssertionFinder {
  constructor(
    private readonly custom: readonly RegExp[],
    private readonly norm: Norm,
    /** Resolves a name in the scope where it is used. */
    private readonly lookup: (name: string) => BindingInfo | undefined,
    /** Whether the file is a `node:test` file. */
    private readonly isNodeTest: () => boolean,
  ) {}

  find(call: AstNode): Assertion | undefined {
    const callee = child(call, 'callee');
    if (!callee) return undefined;
    const c = unwrap(callee);
    const args = children(call, 'arguments');

    if (c.type === 'MemberExpression') {
      const chain = this.expectChain(c, args);
      if (chain) return chain;
    }

    // The path as written: `helpers.expectOk(...)` is a local name, so it must not go through
    // the framework-name normalizer.
    const path = memberPath(c);
    if (!path) return undefined;
    const asserted = this.assertCall(path, args);
    if (asserted) return asserted;

    if (path[0] !== 'expect' && this.custom.some((re) => re.test(path.join('.')))) {
      return { ref: { name: path.join('.') }, subject: args[0] };
    }
    return undefined;
  }

  private expectChain(member: AstNode, args: AstNode[]): Assertion | undefined {
    if (member['computed'] === true) return undefined;
    const prop = child(member, 'property');
    const matcher = prop ? str(prop, 'name') : undefined;
    const object = child(member, 'object');
    if (!matcher || !object) return undefined;

    let obj = unwrap(object);
    let negated = false;
    const modifiers: ResolveModifier[] = [];
    while (obj.type === 'MemberExpression' && obj['computed'] !== true) {
      const p = child(obj, 'property');
      const name = p ? str(p, 'name') : undefined;
      const inner = child(obj, 'object');
      if (!name || !CHAIN_MODS.has(name) || !inner) break;
      if (name === 'not') negated = !negated;
      else modifiers.push(name as ResolveModifier);
      obj = unwrap(inner);
    }
    if (obj.type !== 'CallExpression') return undefined;
    const expectCallee = child(obj, 'callee');
    const root = expectCallee ? this.norm(memberPath(expectCallee))?.join('.') : undefined;
    if (!root || !EXPECT_ROOTS.has(root)) return undefined;

    const subject = children(obj, 'arguments')[0];
    return {
      ref: { name: matcher, negated, arg: argKind(args[0], this.norm), modifiers },
      subject: root === 'expect.poll' ? undefined : subject,
    };
  }

  /**
   * `assert.equal(...)`, `strictEqual(...)`, `ctx.assert.equal(...)`. What the first name stands
   * for comes from its binding in the scope of the call, so a local `assert` or `check` that
   * happens to share a name with an import is not node:assert.
   */
  private assertCall(path: string[], args: AstNode[]): Assertion | undefined {
    const head = path[0] ?? '';
    const binding = this.lookup(head);
    let rest: string[];
    let strict: boolean;
    let method: string | undefined;

    const viaContext = path[1] === 'assert' && binding?.param === true && this.isNodeTest();
    if (viaContext) {
      // the callback parameter of a node:test test; its assert object is the loose one
      rest = path.slice(2);
      strict = rest.includes('strict');
    } else if (path.length === 1 && binding?.assert?.kind === 'named') {
      method = binding.assert.imported;
      strict = binding.assert.strict;
      rest = [];
    } else {
      const ns: AssertBinding | undefined =
        binding?.assert?.kind === 'namespace'
          ? binding.assert
          : // `assert` from another library, or an unresolved global, behaves like the loose one
            head === 'assert' && (binding === undefined || binding.importFrom !== undefined)
            ? { kind: 'namespace', strict: false }
            : undefined;
      if (!ns) return undefined;
      rest = path.slice(1);
      strict = ns.strict || rest.includes('strict');
    }

    if (method === undefined) {
      const names = rest.filter((s) => s !== 'strict');
      if (names.length === 0 && !viaContext) method = 'ok';
      else if (names.length === 1) method = names[0];
    }
    if (!method) return undefined;
    if (strict) method = STRICT_METHODS[method] ?? method;
    const name = `assert.${method}`;
    const argIndex = ASSERT_CALLEE_ARG[name] ?? 0;
    return { ref: { name, arg: argKind(args[argIndex], this.norm) }, subject: args[0] };
  }
}

// ---------------------------------------------------------------------------------------------
// Mock detection

const MOCK_FACTORIES = new Set([
  'vi.fn',
  'vi.spyOn',
  'vi.mocked',
  'jest.fn',
  'jest.spyOn',
  'jest.mocked',
]);
const MODULE_MOCKS = new Set(['vi.mock', 'vi.doMock', 'jest.mock', 'jest.doMock']);

interface SubjectSignals {
  root?: string;
  /** The subject goes through `.mock` or `vi.mocked(...)`. */
  viaMock: boolean;
}

function subjectSignals(subject: AstNode | undefined, norm: Norm): SubjectSignals {
  let n = subject ? unwrap(subject) : undefined;
  let viaMock = false;
  for (let guard = 0; n && guard < 50; guard++) {
    if (n.type === 'Identifier') return { root: str(n, 'name') ?? '', viaMock };
    if (n.type === 'AwaitExpression') {
      const arg = child(n, 'argument');
      n = arg ? unwrap(arg) : undefined;
    } else if (n.type === 'MemberExpression') {
      const p = child(n, 'property');
      if (n['computed'] !== true && p && str(p, 'name') === 'mock') viaMock = true;
      const o = child(n, 'object');
      n = o ? unwrap(o) : undefined;
    } else if (n.type === 'CallExpression') {
      const callee = child(n, 'callee');
      const path = callee ? norm(memberPath(callee)) : undefined;
      if (path && MOCK_FACTORIES.has(path.join('.'))) viaMock = true;
      n = callee ? unwrap(callee) : undefined;
    } else {
      break;
    }
  }
  return { viaMock };
}

// ---------------------------------------------------------------------------------------------
// Body hash

const HASH_SKIP = new Set([
  'start',
  'end',
  'raw',
  'loc',
  'range',
  'typeAnnotation',
  'typeParameters',
  'typeArguments',
  'returnType',
  'decorators',
]);

/**
 * Hash of an AST subtree that ignores positions, comments, formatting and type annotations.
 * Primitive values keep their type, so `1` and `'1'` differ. Runtime TypeScript (namespaces,
 * enums) is hashed; type-only nodes are not.
 */
export function hashNode(node: AstNode | undefined): string {
  const h = createHash('sha1');
  const feed = (v: unknown): void => {
    if (Array.isArray(v)) {
      h.update('[');
      for (const x of v) feed(x);
      h.update(']');
    } else if (typeof v === 'object' && v !== null) {
      const obj = v as Record<string, unknown>;
      if (typeof obj['type'] === 'string') {
        const n = obj as AstNode;
        if (isTypeOnly(n)) return;
        if (isTsValueWrapper(n)) {
          feed(obj['expression']); // `x as T` hashes like `x`
          return;
        }
      }
      h.update('{');
      for (const key of Object.keys(obj)) {
        if (HASH_SKIP.has(key)) continue;
        // `optional` is a type-level marker on identifiers and parameters, but it changes what
        // `a?.b()` and `a.b?.()` do at runtime.
        if (
          key === 'optional' &&
          obj['type'] !== 'MemberExpression' &&
          obj['type'] !== 'CallExpression'
        ) {
          continue;
        }
        h.update(key);
        h.update(':');
        feed(obj[key]);
      }
      h.update('}');
    } else {
      // type-tagged and JSON-escaped, so 1, '1', true and 'true' are all different
      h.update(`${typeof v}:${typeof v === 'bigint' ? `${v}n` : JSON.stringify(v)},`);
    }
  };
  feed(node ?? null);
  return h.digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------------------------
// Imports

const FRAMEWORK_MODULES: Record<string, TestSummary['framework']> = {
  vitest: 'vitest',
  '@jest/globals': 'jest',
  '@playwright/test': 'playwright',
  'node:test': 'node-test',
  test: 'node-test',
};

// ---------------------------------------------------------------------------------------------
// Lexical scopes
//
// Names are resolved through real scopes, not by spelling, so a mock or helper called `result` or
// `check` in one test never leaks into another, and a local `expect` is not the framework's.
// Helpers are resolved when the walk is finished, so one declared after the test that uses it is
// still found. Mock state is the opposite: it is read at the moment of each use, because a later
// `fn = realFn` must not change what an earlier `expect(fn)` was about.

/** Whether a value is a mock, as of one moment. Module mocks are checked once the walk is done. */
interface MockState {
  mock: boolean;
  /** Modules this value was imported from along the way; mocked if `vi.mock` names one of them. */
  imports: string[];
}

const NOT_MOCK: MockState = { mock: false, imports: [] };

/** Code that runs only when called: a named function, or a method of a local object. */
interface HelperDef {
  node: AstNode;
  entries: Entry[];
  /** Tests declared inside it, relative to it. They exist only where it is called. */
  templates: RawTest[];
  /** How many describe frames were open where it was defined. */
  frameBase: number;
  /** The scope it was defined in. */
  outer: Scope;
}

interface Binding extends BindingInfo {
  /** Created by `vi.fn()`, `jest.fn()`, `spyOn(...)` or `vi.mocked(...)`. */
  mock: boolean;
  /** Set for imports from a framework module: what the local name stands for. */
  framework?: { kind: 'named'; imported: string } | { kind: 'namespace' };
  /** `const result = mockFn()`: whether `mockFn` was a mock when `result` was assigned. */
  derived?: MockState;
  /** Declared by hoisting but not reached yet: what it will be is not known. */
  pending?: boolean;
  /** A named function, followed one level deep when a test calls it. */
  helper?: HelperDef;
  /** `const page = { expectOk() {} }`: methods that run when called as `page.expectOk()`. */
  methods?: Map<string, HelperDef>;
}

class Scope {
  readonly names = new Map<string, Binding>();

  constructor(
    readonly parent?: Scope,
    /** Function bodies and the file are function scopes: `var` lands in the nearest one. */
    readonly isFunction = false,
  ) {}

  functionScope(): Scope {
    return this.isFunction || !this.parent ? this : this.parent.functionScope();
  }

  lookup(name: string): Binding | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
  }

  /** The scope that declares `name`. */
  owner(name: string): Scope | undefined {
    return this.names.has(name) ? this : this.parent?.owner(name);
  }

  /** Is this scope `other` or inside it? */
  within(other: Scope): boolean {
    return this === other || (this.parent?.within(other) ?? false);
  }
}

function patternNames(pattern: AstNode | undefined, out: string[]): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': {
      const name = str(pattern, 'name');
      if (name) out.push(name);
      break;
    }
    case 'AssignmentPattern':
      patternNames(child(pattern, 'left'), out);
      break;
    case 'RestElement':
      patternNames(child(pattern, 'argument'), out);
      break;
    case 'TSParameterProperty':
      patternNames(child(pattern, 'parameter'), out);
      break;
    case 'ArrayPattern':
      for (const el of children(pattern, 'elements')) patternNames(el, out);
      break;
    case 'ObjectPattern':
      for (const prop of children(pattern, 'properties')) {
        patternNames(prop.type === 'Property' ? child(prop, 'value') : prop, out);
      }
      break;
    default:
      break;
  }
}

/**
 * APIs that call the function they are given. Passing a helper to anything else (`vi.fn(check)`,
 * `register(check)`) does not run it, so it does not count as running its assertions.
 */
const CALLBACK_APIS = new Set([
  'forEach',
  'map',
  'flatMap',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'reduce',
  'reduceRight',
  'sort',
  'then',
  'catch',
  'finally',
  'step',
  'waitFor',
  'act',
  'poll',
]);

/**
 * Calls whose function arguments are only stored, not run: mock factories and implementations,
 * and module mock factories. Assertions written inside them do not run with the test.
 */
const DEFERRING_APIS = new Set([
  'fn',
  'spyOn',
  'mock',
  'doMock',
  'mockImplementation',
  'mockImplementationOnce',
]);

/** Marks a path head that is a local declaration, so it cannot match a framework name. */
const LOCAL = '\0local:';

// ---------------------------------------------------------------------------------------------
// The collector

interface Frame {
  node: AstNode;
  name: string;
  modifier: TestModifier | undefined;
  /** Where this describe's own modifier was written. */
  loc: { line: number; col: number };
  timeout: number | undefined;
}

type Entry =
  | {
      pos: number;
      ref: MatcherRef;
      signals: SubjectSignals;
      mock: MockState;
      /** The assertion call and the value it checks, for rules that inspect the syntax. */
      node: AstNode;
      loc: { line: number; col: number };
      subject: AstNode | undefined;
    }
  /** A reference that may run a local helper: `check()`, `page.expectOk()`, `items.forEach(check)`. */
  | { pos: number; call: string; method?: string; scope: Scope; def?: HelperDef | null }
  /** A timeout set from inside a test or a helper, applied to the test that runs it. */
  | { pos: number; timeout: number };

interface RawTest {
  name: string;
  /** Describe names around it. For a test declared inside a helper: relative to the helper. */
  path: string[];
  loc: { line: number; col: number };
  modifier: TestModifier | undefined;
  timeout: number | undefined;
  /** Describe frames around this test, outermost first. Their state is read when finished. */
  ancestors: Frame[];
  bodyHash: string | undefined;
  /** The body of an inline test callback, and the callback itself. */
  body: AstNode | undefined;
  fn: AstNode | undefined;
  /** For `test('x', namedFn)`: what the name stood for, or resolved when finished. */
  fnRef: { node: AstNode; scope: Scope; def?: HelperDef | null } | undefined;
  entries: Entry[];
  /** Source order, used to number duplicates and to place tests a helper registers. */
  order: number;
}

/** A call to a function that may register tests, made where tests are declared. */
interface Invocation {
  name: string;
  scope: Scope;
  /**
   * What the name stood for at the call: a function, `null` for something known not to be one,
   * or absent for a name not declared yet (looked up when finished).
   */
  def?: HelperDef | null;
  /** Describe frames open at the call. */
  frames: Frame[];
  pos: number;
}

interface Target {
  node: AstNode;
  entries: Entry[];
  kind: 'test' | 'helper';
  def?: HelperDef;
}

export interface SummaryCollector {
  visitor: Visitor;
  /** Call after the walk. */
  finish(source: string): TestSummary;
  /** Per-test detail for rules. Call after `finish`; it is not part of the summary. */
  facts(): TestFacts[];
  /** `vi.mock` / `jest.mock` calls that take effect, in source order. */
  mocks(): ModuleMock[];
}

export function createSummaryCollector(options: SummaryOptions = {}): SummaryCollector {
  const lattice: Lattice = createLattice(options.matchers ?? {});

  const root = new Scope();
  let scope = root;

  /**
   * Resolves a framework name through the scope it is used in: an aliased import (`test as
   * spec`) or a namespace import maps back to the framework name, and a local declaration with
   * the same name (`const check = ...`) is not the framework at all.
   */
  const norm: Norm = (path) => {
    const head = path?.[0];
    if (!path || head === undefined) return path;
    const binding = scope.lookup(head);
    if (!binding) return path; // a global: jest, vi, expect, test
    const fw = binding.framework;
    if (fw?.kind === 'named') return [fw.imported, ...path.slice(1)];
    if (fw?.kind === 'namespace') return path.length > 1 ? path.slice(1) : path;
    // other imports (bun:test, chai, ...) stay recognised by name; locals shadow the framework
    return binding.importFrom !== undefined ? path : [`${LOCAL}${head}`, ...path.slice(1)];
  };
  const finder = new AssertionFinder(
    (options.assertFunctionNames ?? []).map(globToRegExp),
    norm,
    (name) => scope.lookup(name),
    () => frameworkImports.includes('node-test'),
  );

  const imports: string[] = [];
  const frameworkImports: TestSummary['framework'][] = [];
  const mockedModules = new Set<string>();
  const tests: RawTest[] = [];
  const invocations: Invocation[] = [];
  /** Anonymous functions that only run if something calls them: mock implementations, factories. */
  const deferredFns = new Set<AstNode>();
  /** Suite/file timeouts set while registering tests, applied in source order when finished. */
  const factList: TestFacts[] = [];
  const moduleMocks: ModuleMock[] = [];
  const timeoutEvents: { pos: number; frame: Frame | undefined; ms: number }[] = [];
  /** Helpers an outer name stood for before the running test body rewrote them. */
  const testRestore = new Map<
    Binding,
    { helper: HelperDef | undefined; methods: Map<string, HelperDef> | undefined }
  >();
  let sawVi = false;
  let sawJest = false;
  let fileTimeout: number | undefined;

  const frames: Frame[] = [];
  /** Where assertions go: the innermost test or deferred function being walked. */
  const targets: Target[] = [];
  let currentTest: RawTest | undefined;
  let currentTestNode: AstNode | undefined;
  /** The scope the current test was declared in; its own bindings are inside that. */
  let currentTestOuter: Scope | undefined;
  /** Whether the current test (or a `describe` around it) switches it off. */
  const currentTestIsOff = (): boolean =>
    currentTest !== undefined &&
    [currentTest.modifier, ...currentTest.ancestors.map((f) => f.modifier)].some(
      (m) => m === 'skip' || m === 'todo' || m === 'fixme',
    );

  const addImport = (spec: string | undefined): void => {
    if (spec !== undefined && !imports.includes(spec)) imports.push(spec);
  };
  const pathOf = (node: AstNode | undefined): string[] | undefined =>
    node ? norm(memberPath(node)) : undefined;
  const nameOf = (source: string, node: AstNode): string =>
    staticString(node) ?? sourceText(source, unwrap(node));
  const push = (entry: Entry): void => {
    targets[targets.length - 1]?.entries.push(entry);
  };
  /** A reference to a name that may be a helper, remembering what it was at this point. */
  const defAt = (name: string, method?: string): HelperDef | null | undefined => {
    const binding = scope.lookup(name);
    if (!binding || binding.pending) return undefined; // not declared yet
    return (method === undefined ? binding.helper : binding.methods?.get(method)) ?? null;
  };
  const callEntry = (pos: number, name: string, method?: string): Entry => {
    const def = defAt(name, method);
    return {
      pos,
      call: name,
      ...(method === undefined ? {} : { method }),
      scope,
      ...(def !== undefined ? { def } : {}),
    };
  };
  const popTarget = (node: AstNode): void => {
    if (targets[targets.length - 1]?.node === node) targets.pop();
  };
  const pushScope = (isFunction = false): void => {
    scope = new Scope(scope, isFunction);
  };
  const popScope = (): void => {
    scope = scope.parent ?? root;
  };
  /** The innermost function being walked that only runs when called. */
  const innermostHelper = (): Target | undefined => {
    for (let i = targets.length - 1; i >= 0; i--)
      if (targets[i]!.kind === 'helper') return targets[i];
    return undefined;
  };
  const bindParams = (fn: AstNode): void => {
    const names: string[] = [];
    const params = children(fn, 'params');
    for (const param of params) patternNames(param, names);
    for (const name of names) scope.names.set(name, { mock: false, param: true });
  };

  /**
   * Whether a name is a mock, as of right now.
   *
   * Known limit: an assertion inside a helper is read where the helper is written, not where it
   * is called. `let fn = vi.fn(); function check() { expect(fn)... }` followed by a test that
   * does `fn = realFn; check()` still reports a mock. Only `subjectIsMock` is affected, never
   * which assertions exist, because doing it exactly needs the state of every outer variable at
   * every call site.
   */
  const mockStateOf = (binding: Binding | undefined): MockState => {
    if (!binding) return NOT_MOCK;
    if (binding.mock) return { mock: true, imports: [] };
    const imported = binding.importFrom !== undefined ? [binding.importFrom] : [];
    const derived = binding.derived;
    return derived
      ? { mock: derived.mock, imports: [...imported, ...derived.imports] }
      : { mock: false, imports: imported };
  };

  /** What a value is, taken from its initializer or the right-hand side of an assignment. */
  const bindingFrom = (
    valueRaw: AstNode | undefined,
  ): Pick<Binding, 'mock' | 'derived' | 'helper' | 'methods'> => {
    if (!valueRaw) return { mock: false };
    const value = unwrap(valueRaw);
    const signals = subjectSignals(value, norm);
    const call = value.type === 'AwaitExpression' ? child(value, 'argument') : value;
    const inner = call ? unwrap(call) : undefined;
    const factory = inner?.type === 'CallExpression' ? pathOf(child(inner, 'callee')) : undefined;
    if ((factory && MOCK_FACTORIES.has(factory.join('.'))) || signals.viaMock)
      return { mock: true };
    const out: ReturnType<typeof bindingFrom> = { mock: false };
    if (signals.root) {
      const source = scope.lookup(signals.root);
      out.derived = mockStateOf(source);
      // `check = noop` is the same function: it keeps what `noop` runs
      if (value.type === 'Identifier' && source) {
        if (source.helper) out.helper = source.helper;
        if (source.methods) out.methods = source.methods;
      }
    }
    return out;
  };

  const keyName = (key: AstNode): string | undefined => str(key, 'name') ?? staticString(key);

  /**
   * `test.skip()` / `test.fixme()` (or with `true`) directly in a test body skips that test
   * at run time. Anything conditional or nested in other control flow is not certain.
   */
  const runtimeSkip = (call: AstNode, joined: string, ctx: WalkContext): void => {
    if (!currentTest || (joined !== 'test.skip' && joined !== 'test.fixme')) return;
    const args = children(call, 'arguments');
    const first = args[0] ? unwrap(args[0]) : undefined;
    if (
      args.length > 0 &&
      !(args.length === 1 && first?.type === 'Literal' && first.value === true)
    ) {
      return;
    }
    const at = ctx.ancestors.length - 1;
    if (ctx.ancestors[at]?.type !== 'ExpressionStatement') return;
    // only plain blocks and functions between the test declaration and the call
    for (let i = at - 1; i >= 0; i--) {
      const a = ctx.ancestors[i]!;
      if (a === currentTestNode) break;
      if (a.type !== 'BlockStatement' && !isFunction(a) && a.type !== 'CallExpression') return;
      if (a.type === 'CallExpression' && a !== currentTestNode) return;
    }
    currentTest.modifier = pickModifier(
      [currentTest.modifier, joined.slice(5) as TestModifier].filter(
        (m): m is TestModifier => m !== undefined,
      ),
    );
  };

  const timeoutCall = (call: AstNode, path: string[]): void => {
    const args = children(call, 'arguments');
    const joined = path.join('.');
    let ms: number | undefined;
    if (joined === 'jest.setTimeout' || joined === 'test.setTimeout' || joined === 'vi.setConfig') {
      const a = args[0] ? unwrap(args[0]) : undefined;
      if (a?.type === 'ObjectExpression') {
        for (const prop of children(a, 'properties')) {
          const key = child(prop, 'key');
          const value = child(prop, 'value');
          if (key && value && keyName(key) === 'testTimeout') ms = staticNumber(value);
        }
      } else if (a) {
        ms = staticNumber(a);
      }
    } else if (joined === 'test.describe.configure') {
      const a = args[0] ? unwrap(args[0]) : undefined;
      for (const prop of a ? children(a, 'properties') : []) {
        const key = child(prop, 'key');
        const value = child(prop, 'value');
        if (key && value && keyName(key) === 'timeout') ms = staticNumber(value);
      }
    }
    if (ms === undefined) return;
    // Inside a test or a helper it is an effect of running that code, applied where it runs.
    if (targets.length > 0) push({ pos: call.start, timeout: ms });
    // Suite configuration applies to the whole suite wherever it appears, and the last call wins.
    else timeoutEvents.push({ pos: call.start, frame: frames[frames.length - 1], ms });
  };

  const fnRefOf = (node: AstNode): NonNullable<RawTest['fnRef']> => {
    const def = defAt(str(node, 'name') ?? '');
    return { node, scope, ...(def !== undefined ? { def } : {}) };
  };
  const invocationOf = (name: string, pos: number): Invocation => {
    const def = defAt(name);
    return { name, scope, frames: [...frames], pos, ...(def !== undefined ? { def } : {}) };
  };

  const onCall = (node: AstNode, ctx: WalkContext): void => {
    const callee = child(node, 'callee');
    const calleePath = pathOf(callee);

    if (calleePath) {
      const joined = calleePath.join('.');
      if (joined === 'require') addImport(staticString(children(node, 'arguments')[0] ?? node));
      if (MODULE_MOCKS.has(joined)) {
        const spec = children(node, 'arguments')[0];
        const s = spec ? staticString(spec) : undefined;
        // vi.mock is hoisted to the top of the file; vi.doMock only acts when it runs
        const neverRuns = joined.endsWith('doMock') && innermostHelper() !== undefined;
        if (s !== undefined && !neverRuns) {
          mockedModules.add(s);
          const factory = children(node, 'arguments')[1];
          moduleMocks.push({
            spec: s,
            loc: ctx.loc(node.start),
            node,
            ...(factory ? { factory: unwrap(factory) } : {}),
          });
        }
      }
      if (calleePath[0] === 'vi') sawVi = true;
      if (calleePath[0] === 'jest') sawJest = true;
      timeoutCall(node, calleePath);
      runtimeSkip(node, joined, ctx);
    }

    // vi.fn(() => ...), .mockImplementation(() => ...), vi.mock('x', () => ...): stored, not run
    const calleeNode = callee ? unwrap(callee) : undefined;
    const calleeLast =
      calleeNode?.type === 'Identifier'
        ? str(calleeNode, 'name')
        : calleeNode?.type === 'MemberExpression' && calleeNode['computed'] !== true
          ? str(child(calleeNode, 'property') ?? calleeNode, 'name')
          : undefined;
    if (calleeLast && DEFERRING_APIS.has(calleeLast)) {
      for (const arg of children(node, 'arguments')) {
        const a = unwrap(arg);
        if (isFunction(a)) deferredFns.add(a);
      }
    }

    // describe / test declarations (not nested inside a test body)
    if (!currentTest) {
      const decl = parseDecl(node, norm);
      if (decl) {
        const name = nameOf(ctx.source, decl.nameNode);
        const mod = pickModifier(decl.modifiers);
        const helper =
          targets[targets.length - 1]?.kind === 'helper' ? innermostHelper() : undefined;
        if (decl.kind === 'describe') {
          frames.push({
            node,
            name,
            modifier: mod,
            loc: ctx.loc(node.start),
            timeout: decl.timeout,
          });
          // describe('s', register): the tests register() declares belong under 's'
          if (decl.fnRef && !helper) {
            invocations.push(invocationOf(str(decl.fnRef, 'name') ?? '', node.start));
          }
        } else {
          const entries: Entry[] = [];
          const base = helper?.def?.frameBase ?? 0;
          const raw: RawTest = {
            name,
            path: frames.slice(base).map((f) => f.name),
            loc: ctx.loc(node.start),
            modifier: mod,
            timeout: decl.timeout,
            ancestors: frames.slice(base),
            bodyHash: decl.fn ? hashNode(child(decl.fn, 'body')) : undefined,
            body: decl.fn ? child(decl.fn, 'body') : undefined,
            fn: decl.fn,
            fnRef: decl.fnRef ? fnRefOf(decl.fnRef) : undefined,
            entries,
            order: node.start,
          };
          // a function that registers tests only does so where it is called
          if (helper?.def) helper.def.templates.push(raw);
          else tests.push(raw);
          currentTest = raw;
          currentTestNode = node;
          currentTestOuter = scope;
          targets.push({ node, entries, kind: 'test' });
        }
        return;
      }
    }

    // assertions
    const found = finder.find(node);
    if (found) {
      const signals = subjectSignals(found.subject, norm);
      push({
        pos: node.start,
        ref: found.ref,
        signals,
        mock: signals.root ? mockStateOf(scope.lookup(signals.root)) : NOT_MOCK,
        node,
        loc: ctx.loc(node.start),
        subject: found.subject,
      });
      return;
    }

    if (!callee) return;
    const c = unwrap(callee);

    // a call where tests are declared may register tests: shared suites, `register()`,
    // and `[a, b].forEach(register)`
    if (targets.length === 0) {
      if (c.type === 'Identifier') {
        invocations.push(invocationOf(str(c, 'name') ?? '', node.start));
      } else if (c.type === 'MemberExpression' && c['computed'] !== true) {
        const property = child(c, 'property');
        const method = property ? str(property, 'name') : undefined;
        if (method && CALLBACK_APIS.has(method)) {
          for (const arg of children(node, 'arguments')) {
            const a = unwrap(arg);
            if (a.type === 'Identifier')
              invocations.push(invocationOf(str(a, 'name') ?? '', a.start));
          }
        }
      }
    }

    // references that may run a local helper
    if (targets.length === 0) return;
    let calleeName: string | undefined;
    if (c.type === 'Identifier') {
      calleeName = str(c, 'name');
      push(callEntry(node.start, calleeName ?? '')); // check()
    } else if (c.type === 'MemberExpression' && c['computed'] !== true) {
      const object = child(c, 'object');
      const property = child(c, 'property');
      calleeName = property ? str(property, 'name') : undefined;
      const objectName =
        object && unwrap(object).type === 'Identifier' ? str(unwrap(object), 'name') : undefined;
      if (objectName && calleeName) {
        push(callEntry(node.start, objectName, calleeName)); // page.expectOk()
      }
    }
    // a helper passed to an API that calls it: items.forEach(check), waitFor(check)
    if (calleeName && CALLBACK_APIS.has(calleeName)) {
      for (const arg of children(node, 'arguments')) {
        const a = unwrap(arg);
        if (a.type === 'Identifier') push(callEntry(a.start, str(a, 'name') ?? ''));
      }
    }
  };

  const enterFunction = (node: AstNode): void => {
    // a callback of a mock factory or mock implementation only runs if something calls the mock
    if (deferredFns.has(node)) deferFunction(node);
    pushScope(true);
    bindParams(node);
  };

  /**
   * Declarations are hoisted: their names exist from the top of their scope, so an earlier use
   * refers to them (and not to an outer name or the framework), though what they hold is not
   * known until the declaration is reached.
   */
  const hoistDeclarations = (body: AstNode[]): void => {
    const declare = (owner: Scope, name: string): void => {
      if (!owner.names.has(name)) owner.names.set(name, { mock: false, pending: true });
    };
    for (const statement of body) {
      const declaration =
        statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
          ? child(statement, 'declaration')
          : statement;
      if (!declaration) continue;
      if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
        const id = child(declaration, 'id');
        const name = id ? str(id, 'name') : undefined;
        if (name) declare(scope, name);
      } else if (declaration.type === 'VariableDeclaration') {
        const owner = str(declaration, 'kind') === 'var' ? scope.functionScope() : scope;
        for (const d of children(declaration, 'declarations')) {
          const names: string[] = [];
          patternNames(child(d, 'id'), names);
          for (const name of names) declare(owner, name);
        }
      }
    }
  };

  /** A function value that is stored, not run: its body must not count for the enclosing test. */
  const deferFunction = (node: AstNode): HelperDef => {
    const def: HelperDef = {
      node,
      entries: [],
      templates: [],
      frameBase: frames.length,
      outer: scope,
    };
    targets.push({ node, entries: def.entries, kind: 'helper', def });
    return def;
  };

  /**
   * Replace what a local name stands for. An assignment inside a function that has not run yet
   * must not change a binding from outside it: that effect belongs to the call, which we do not
   * follow.
   */
  const reassign = (
    name: string,
    next: Pick<Binding, 'mock' | 'derived' | 'helper' | 'methods'>,
    /** The deferred function the assignment is written in, if any. */
    enclosing: Target | undefined,
  ): void => {
    const owner = scope.owner(name);
    const binding = owner?.names.get(name);
    if (!owner || !binding || binding.importFrom !== undefined) return;
    if (enclosing?.def && enclosing.def.outer.within(owner)) return;
    // a skipped test never runs, so it changes nothing outside itself
    if (currentTestOuter?.within(owner) && currentTestIsOff()) return;
    // a later test is declared before this one runs: it sees the function as written
    if (currentTest && currentTestOuter?.within(owner) && !testRestore.has(binding)) {
      testRestore.set(binding, { helper: binding.helper, methods: binding.methods });
    }
    binding.mock = next.mock;
    if (next.derived) binding.derived = next.derived;
    else delete binding.derived;
    if (next.helper) binding.helper = next.helper;
    else delete binding.helper;
    if (next.methods) binding.methods = next.methods;
    else delete binding.methods;
  };

  /** `require('vitest')` and friends, as the value of a declaration. */
  const fwModuleName = (initRaw: AstNode | undefined): string | undefined => {
    const init = initRaw ? unwrap(initRaw) : undefined;
    if (init?.type !== 'CallExpression') return undefined;
    const callee = child(init, 'callee');
    if (
      !callee ||
      unwrap(callee).type !== 'Identifier' ||
      str(unwrap(callee), 'name') !== 'require'
    ) {
      return undefined;
    }
    const spec = children(init, 'arguments')[0];
    const name = spec ? staticString(spec) : undefined;
    return name !== undefined && FRAMEWORK_MODULES[name] ? name : undefined;
  };
  const frameworkFromRequire = (
    initRaw: AstNode | undefined,
  ): TestSummary['framework'] | undefined => {
    const name = fwModuleName(initRaw);
    return name === undefined ? undefined : FRAMEWORK_MODULES[name];
  };

  /** `require('node:assert')` and friends, as the value of a declaration. */
  const assertFromRequire = (initRaw: AstNode | undefined): { strict: boolean } | undefined => {
    if (!initRaw) return undefined;
    let init = unwrap(initRaw);
    let strict = false;
    // require('node:assert').strict
    if (init.type === 'MemberExpression' && init['computed'] !== true) {
      const property = child(init, 'property');
      const object = child(init, 'object');
      if (property && str(property, 'name') === 'strict' && object) {
        strict = true;
        init = unwrap(object);
      }
    }
    if (init.type !== 'CallExpression') return undefined;
    const callee = child(init, 'callee');
    const spec = children(init, 'arguments')[0];
    const moduleName = spec ? staticString(spec) : undefined;
    if (!callee || memberPath(callee)?.join('.') !== 'require' || moduleName === undefined) {
      return undefined;
    }
    if (ASSERT_STRICT_MODULES.has(moduleName)) return { strict: true };
    return ASSERT_MODULES.has(moduleName) ? { strict } : undefined;
  };

  /** Imports are hoisted: they bind before any code in the file runs. */
  const registerImport = (node: AstNode): void => {
    const src = child(node, 'source');
    const spec = src ? staticString(src) : undefined;
    if (spec === undefined || str(node, 'importKind') === 'type') return;
    addImport(spec);
    const framework = FRAMEWORK_MODULES[spec];
    if (framework) frameworkImports.push(framework);
    const isAssert = ASSERT_MODULES.has(spec);
    const isStrictAssert = ASSERT_STRICT_MODULES.has(spec);
    for (const s of children(node, 'specifiers')) {
      const local = child(s, 'local');
      const name = local ? str(local, 'name') : undefined;
      if (!name) continue;
      const binding: Binding = { mock: false, importFrom: spec };
      root.names.set(name, binding);
      const imported = child(s, 'imported');
      const importedName = imported ? (str(imported, 'name') ?? staticString(imported)) : undefined;

      if (framework) {
        if (s.type === 'ImportNamespaceSpecifier') binding.framework = { kind: 'namespace' };
        else if (s.type === 'ImportDefaultSpecifier') {
          binding.framework = { kind: 'named', imported: 'test' };
        } else if (importedName) binding.framework = { kind: 'named', imported: importedName };
      }
      if (isAssert || isStrictAssert) {
        if (s.type === 'ImportSpecifier' && importedName === 'strict') {
          binding.assert = { kind: 'namespace', strict: true };
        } else if (s.type === 'ImportSpecifier' && importedName) {
          binding.assert = { kind: 'named', imported: importedName, strict: isStrictAssert };
        } else {
          binding.assert = { kind: 'namespace', strict: isStrictAssert };
        }
      }
    }
  };

  const visitor: Visitor = {
    ExportNamedDeclaration(node) {
      const src = child(node, 'source');
      if (src) addImport(staticString(src));
    },
    ExportAllDeclaration(node) {
      const src = child(node, 'source');
      if (src) addImport(staticString(src));
    },
    ImportExpression(node) {
      const src = child(node, 'source');
      if (src) addImport(staticString(src));
    },

    CallExpression: onCall,
    'CallExpression:exit'(node) {
      if (node === currentTestNode) {
        currentTest = undefined;
        currentTestNode = undefined;
        for (const [binding, original] of testRestore) {
          if (original.helper) binding.helper = original.helper;
          else delete binding.helper;
          if (original.methods) binding.methods = original.methods;
          else delete binding.methods;
        }
        testRestore.clear();
        popTarget(node);
      }
      const top = frames[frames.length - 1];
      if (top && top.node === node) frames.pop();
    },

    Program(node) {
      for (const stmt of children(node, 'body')) {
        if (stmt.type === 'ImportDeclaration') registerImport(stmt);
      }
      hoistDeclarations(children(node, 'body'));
    },
    FunctionDeclaration(node) {
      const id = child(node, 'id');
      const name = id ? str(id, 'name') : undefined;
      // A named function is a helper: its assertions count only where it is called.
      if (name) {
        const binding = scope.names.get(name) ?? { mock: false };
        binding.mock = false;
        delete binding.pending;
        binding.helper = deferFunction(node);
        scope.names.set(name, binding);
      }
      enterFunction(node);
    },
    'FunctionDeclaration:exit'(node) {
      popScope();
      popTarget(node);
    },
    FunctionExpression: enterFunction,
    'FunctionExpression:exit'(node) {
      popScope();
      popTarget(node);
    },
    ArrowFunctionExpression: enterFunction,
    'ArrowFunctionExpression:exit'(node) {
      popScope();
      popTarget(node);
    },

    ClassDeclaration(node) {
      const id = child(node, 'id');
      const name = id ? str(id, 'name') : undefined;
      if (name) scope.names.set(name, { mock: false });
    },
    // namespace N { ... } is a function-like scope of its own
    TSModuleBlock(node) {
      pushScope(true);
      hoistDeclarations(children(node, 'body'));
    },
    'TSModuleBlock:exit': popScope,
    // [() => ..., () => ...] and class fields store functions that run only when called
    ArrayExpression(node) {
      for (const element of children(node, 'elements')) {
        const e = unwrap(element);
        if (isFunction(e)) deferredFns.add(e);
      }
    },
    PropertyDefinition(node) {
      const value = child(node, 'value');
      const fn = value ? unwrap(value) : undefined;
      if (fn && isFunction(fn)) deferredFns.add(fn);
    },

    BlockStatement(node) {
      pushScope();
      hoistDeclarations(children(node, 'body'));
    },
    'BlockStatement:exit': popScope,
    ForStatement: () => pushScope(),
    'ForStatement:exit': popScope,
    ForInStatement: () => pushScope(),
    'ForInStatement:exit': popScope,
    ForOfStatement: () => pushScope(),
    'ForOfStatement:exit': popScope,
    CatchClause(node) {
      pushScope();
      const names: string[] = [];
      patternNames(child(node, 'param'), names);
      for (const name of names) scope.names.set(name, { mock: false });
    },
    'CatchClause:exit': popScope,

    VariableDeclarator(node, ctx) {
      // `var` belongs to the nearest function (or the file), not to the block it is written in
      const declaration = ctx.ancestors[ctx.ancestors.length - 1];
      const owner =
        declaration && str(declaration, 'kind') === 'var' ? scope.functionScope() : scope;
      const id = child(node, 'id');
      const initRaw = child(node, 'init');
      const names: string[] = [];
      patternNames(id, names);
      const init = initRaw ? unwrap(initRaw) : undefined;

      if (init && isFunction(init) && id?.type === 'Identifier' && names[0]) {
        owner.names.set(names[0], { mock: false, helper: deferFunction(init) });
        targets[targets.length - 1]!.node = node; // popped on the declarator's exit
        return;
      }
      const from = bindingFrom(initRaw);
      for (const name of names) owner.names.set(name, { ...from });

      // const { test } = require('node:test'): a framework binding, not a local shadow
      const fwModule = frameworkFromRequire(initRaw);
      if (fwModule) {
        frameworkImports.push(fwModule);
        if (id?.type === 'Identifier' && names[0]) {
          owner.names.get(names[0])!.framework = { kind: 'named', imported: 'test' };
        } else if (id?.type === 'ObjectPattern') {
          for (const prop of children(id, 'properties')) {
            const key = child(prop, 'key');
            const value = child(prop, 'value');
            const imported = key ? keyName(key) : undefined;
            const local = value?.type === 'Identifier' ? str(value, 'name') : undefined;
            const binding = local ? owner.names.get(local) : undefined;
            if (imported && binding) binding.framework = { kind: 'named', imported };
          }
        }
        for (const n of names) owner.names.get(n)!.importFrom = fwModuleName(initRaw)!;
      }

      // const assert = require('node:assert'), const { strictEqual } = require('node:assert')
      const required = assertFromRequire(initRaw);
      if (required && id?.type === 'Identifier' && names[0]) {
        owner.names.get(names[0])!.assert = { kind: 'namespace', strict: required.strict };
      } else if (required && id?.type === 'ObjectPattern') {
        for (const prop of children(id, 'properties')) {
          const key = child(prop, 'key');
          const value = child(prop, 'value');
          const imported = key ? str(key, 'name') : undefined;
          const local = value?.type === 'Identifier' ? str(value, 'name') : undefined;
          const binding = local ? owner.names.get(local) : undefined;
          if (!imported || !binding) continue;
          binding.assert =
            imported === 'strict'
              ? { kind: 'namespace', strict: true }
              : { kind: 'named', imported, strict: required.strict };
        }
      }
    },
    'VariableDeclarator:exit': popTarget,

    // const page = { expectOk() { ... }, check: () => ... }: functions stored in properties run
    // only when called, so they are isolated, and `page.expectOk()` can find them.
    Property(node, ctx) {
      const value = child(node, 'value');
      const fn = value ? unwrap(value) : undefined;
      if (!fn || !isFunction(fn)) return;
      const def = deferFunction(fn);
      targets[targets.length - 1]!.node = node;
      const object = ctx.ancestors[ctx.ancestors.length - 1];
      const declarator = ctx.ancestors[ctx.ancestors.length - 2];
      const declaredId = declarator ? child(declarator, 'id') : undefined;
      const key = child(node, 'key');
      const keyName = key ? (str(key, 'name') ?? staticString(key)) : undefined;
      if (
        object?.type === 'ObjectExpression' &&
        declarator?.type === 'VariableDeclarator' &&
        declaredId?.type === 'Identifier' &&
        keyName
      ) {
        const binding = scope.names.get(str(declaredId, 'name') ?? '');
        if (binding) (binding.methods ??= new Map()).set(keyName, def);
      }
    },
    'Property:exit': popTarget,
    MethodDefinition(node) {
      const value = child(node, 'value');
      if (value && isFunction(value)) {
        deferFunction(value);
        targets[targets.length - 1]!.node = node;
      }
    },
    'MethodDefinition:exit': popTarget,

    // fn = vi.fn(), helper = () => ..., obj.check = () => ...
    AssignmentExpression(node) {
      if (node['operator'] !== '=') return;
      const leftRaw = child(node, 'left');
      const rightRaw = child(node, 'right');
      if (!leftRaw || !rightRaw) return;
      const left = unwrap(leftRaw);
      const right = unwrap(rightRaw);
      const name = left.type === 'Identifier' ? (str(left, 'name') ?? '') : undefined;
      const enclosing = innermostHelper(); // before the new function is registered
      if (isFunction(right)) {
        const def = deferFunction(right);
        targets[targets.length - 1]!.node = node;
        if (name !== undefined) reassign(name, { mock: false, helper: def }, enclosing);
        return;
      }
      if (name !== undefined) reassign(name, bindingFrom(rightRaw), enclosing);
    },
    'AssignmentExpression:exit': popTarget,
  };

  const finish = (source: string): TestSummary => {
    const isMock = (state: MockState): boolean =>
      state.mock || state.imports.some((spec) => mockedModules.has(spec));

    const toUse = (e: Extract<Entry, { ref: MatcherRef }>): MatcherUse => {
      const resolved = lattice.resolveMatcher(e.ref);
      const use: MatcherUse = {
        name: e.ref.name,
        strength: resolved.strength,
        negated: resolved.negated,
        subjectIsMock: e.signals.viaMock || isMock(e.mock),
      };
      if (resolved.known && resolved.chain !== undefined && resolved.rank !== undefined) {
        use.chain = resolved.chain;
        use.rank = resolved.rank;
      }
      return use;
    };

    const helperOf = (e: Extract<Entry, { call: string }>): HelperDef | undefined => {
      if (e.def !== undefined) return e.def ?? undefined; // what the name stood for at the call
      const binding = e.scope.lookup(e.call); // a function declared later: its final definition
      return e.method === undefined ? binding?.helper : binding?.methods?.get(e.method);
    };

    /** Matchers and timeout effects of some code, with helper calls followed `follow` level(s). */
    const expand = (
      entries: readonly Entry[],
      out: { uses: MatcherUse[]; timeout?: number; facts: AssertionFact[] },
      follow: boolean,
    ): void => {
      for (const entry of [...entries].sort((a, b) => a.pos - b.pos)) {
        if ('ref' in entry) {
          const use = toUse(entry);
          out.uses.push(use);
          out.facts.push({
            node: entry.node,
            loc: entry.loc,
            matcher: use.name,
            strength: use.strength,
            negated: use.negated,
            subject: entry.subject,
            subjectText: entry.subject ? sourceText(source, unwrap(entry.subject)) : undefined,
            subjectIsMock: use.subjectIsMock,
            viaHelper: !follow,
          });
        } else if ('timeout' in entry) out.timeout = entry.timeout;
        else if (follow) {
          const def = helperOf(entry);
          if (def) expand(def.entries, out, false);
        }
      }
    };

    // Tests that a function registers exist once per call, under the suite that calls it.
    const registered: RawTest[] = [];
    for (const call of [...invocations].sort((a, b) => a.pos - b.pos)) {
      const def =
        call.def !== undefined ? (call.def ?? undefined) : call.scope.lookup(call.name)?.helper;
      // a function that sets a timeout while tests are being registered configures the file or
      // the suite that called it, at the call
      for (const entry of def?.entries ?? []) {
        if ('timeout' in entry) {
          timeoutEvents.push({
            pos: call.pos + entry.pos / 1e9,
            frame: call.frames[call.frames.length - 1],
            ms: entry.timeout,
          });
        }
      }
      for (const template of def?.templates ?? []) {
        registered.push({
          ...template,
          path: [...call.frames.map((f) => f.name), ...template.path],
          ancestors: [...call.frames, ...template.ancestors],
          order: call.pos + template.order / 1e9,
        });
      }
    }
    // Suite and file timeouts apply in source order, whichever way they were set.
    for (const event of timeoutEvents.sort((a, b) => a.pos - b.pos)) {
      if (event.frame) event.frame.timeout = event.ms;
      else fileTimeout = event.ms;
    }
    const all = [...tests, ...registered].sort((a, b) => a.order - b.order);

    const used = new Set<string>();
    const counters = new Map<string, number>();
    const cases: TestCase[] = all.map((t) => {
      const out: { uses: MatcherUse[]; timeout?: number; facts: AssertionFact[] } = {
        uses: [],
        facts: [],
      };
      // `test('x', namedFn)`: the named function is the test body, so it is expanded exactly like
      // an inline body, with one level of helper calls.
      const callback = t.fnRef
        ? t.fnRef.def !== undefined
          ? (t.fnRef.def ?? undefined)
          : t.fnRef.scope.lookup(str(t.fnRef.node, 'name') ?? '')?.helper
        : undefined;
      if (callback) expand(callback.entries, out, true);
      expand(t.entries, out, true);

      // Ids are unique even when a title already looks like a suffixed one ('x', 'x', 'x #2').
      const base = [...t.path, t.name].join(' > ');
      let n = counters.get(base) ?? 0;
      let id: string;
      do {
        n++;
        id = n === 1 ? base : `${base} #${n}`;
      } while (used.has(id));
      counters.set(base, n);
      used.add(id);

      const bodyHash =
        t.bodyHash ?? hashNode(callback ? child(callback.node, 'body') : t.fnRef?.node);

      const tc: TestCase = { id, title: t.name, loc: t.loc, matchers: out.uses, bodyHash };
      const inheritedFrom = [...t.ancestors].reverse().find((f) => f.modifier);
      const modifier = t.modifier ?? inheritedFrom?.modifier;
      if (modifier) tc.modifier = modifier;
      const modifiers: NonNullable<TestCase['modifiers']> = [];
      t.ancestors.forEach((frame, i) => {
        if (!frame.modifier) return;
        // the suite's own name path, so the same `describe.only` can be recognised across versions
        const suite = t.path.slice(0, i + 1).join(' > ');
        modifiers.push({ modifier: frame.modifier, loc: frame.loc, suite });
      });
      if (t.modifier) modifiers.push({ modifier: t.modifier, loc: t.loc });
      if (modifiers.length > 0) tc.modifiers = modifiers;
      const timeout =
        out.timeout ??
        t.timeout ??
        [...t.ancestors].reverse().find((f) => f.timeout !== undefined)?.timeout ??
        fileTimeout;
      if (timeout !== undefined) tc.timeoutMs = timeout;
      factList.push({
        id,
        loc: t.loc,
        ...(modifier ? { modifier } : {}),
        ...(t.body ? { body: t.body } : {}),
        ...(t.fn ? { fn: t.fn } : {}),
        assertions: out.facts,
      });
      return tc;
    });

    const framework: TestSummary['framework'] =
      frameworkImports[0] ?? (sawVi ? 'vitest' : sawJest ? 'jest' : 'unknown');
    return { hash: hashText(source), framework, imports, tests: cases };
  };

  return { visitor, finish, facts: () => factList, mocks: () => moduleMocks };
}
