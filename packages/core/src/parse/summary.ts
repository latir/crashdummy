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
export const SUMMARY_VERSION = 3;

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

class AssertionFinder {
  /** Locals bound to the default or namespace import of `node:assert`. */
  readonly assertLocals = new Set<string>(['assert']);
  /** The subset of those locals that are the strict namespace. */
  readonly strictLocals = new Set<string>();
  /** `import { strictEqual } from 'node:assert'`: local name to imported name and strictness. */
  readonly assertNamed = new Map<string, { imported: string; strict: boolean }>();

  constructor(
    private readonly custom: readonly RegExp[],
    private readonly norm: Norm,
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

    // The path as written: `const assert = require('assert')` and `helpers.expectOk(...)` are
    // local names, so they must not go through the framework-name normalizer.
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

  private assertCall(path: string[], args: AstNode[]): Assertion | undefined {
    let p = path;
    // node:test's t.assert.* is its own object, not the file's `assert` import
    const viaTestContext = p[0] === 't' && p[1] === 'assert';
    if (viaTestContext) p = p.slice(1);
    let method: string | undefined; // 'ok' for a bare assert(...) call
    let strict = false;

    const named = p.length === 1 ? this.assertNamed.get(p[0]!) : undefined;
    if (named) {
      method = named.imported;
      strict = named.strict;
    } else if (this.assertLocals.has(p[0] ?? '') && (p[0] !== 't' || path[0] === 't')) {
      const rest = p.slice(1);
      strict = (!viaTestContext && this.strictLocals.has(p[0]!)) || rest.includes('strict');
      const names = rest.filter((s) => s !== 'strict');
      if (names.length === 0) method = rest.length === 0 ? 'ok' : undefined;
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
// Resolution happens when the walk is finished, so a helper declared after the test that uses it
// is still found.

/** Code that runs only when called: a named function, or a method of a local object. */
interface HelperDef {
  node: AstNode;
  entries: Entry[];
}

interface Binding {
  /** Created by `vi.fn()`, `jest.fn()`, `spyOn(...)` or `vi.mocked(...)`. */
  mock: boolean;
  /** For imports: the module they come from. Mocked when that module is `vi.mock`ed. */
  importFrom?: string;
  /** Set for imports from a framework module: what the local name stands for. */
  framework?: { kind: 'named'; imported: string } | { kind: 'namespace' };
  /** `const result = mockFn()`: a value derived from another binding. */
  derivedFrom?: { scope: Scope; name: string };
  /** A named function, followed one level deep when a test calls it. */
  helper?: HelperDef;
  /** `const page = { expectOk() {} }`: methods that run when called as `page.expectOk()`. */
  methods?: Map<string, HelperDef>;
}

class Scope {
  readonly names = new Map<string, Binding>();

  constructor(readonly parent?: Scope) {}

  lookup(name: string): Binding | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
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
  | { pos: number; ref: MatcherRef; signals: SubjectSignals; scope: Scope }
  /** A reference that may run a local helper: `check()`, `page.expectOk()`, `items.forEach(check)`. */
  | { pos: number; call: string; method?: string; scope: Scope }
  /** A timeout set from inside a test or a helper, applied to the test that runs it. */
  | { pos: number; timeout: number };

interface RawTest {
  name: string;
  path: string[];
  loc: { line: number; col: number };
  modifier: TestModifier | undefined;
  timeout: number | undefined;
  /** Describe frames around this test, outermost first. Their state is read when finished. */
  ancestors: Frame[];
  bodyHash: string | undefined;
  /** For `test('x', namedFn)`: resolved when finished. */
  fnRef: { node: AstNode; scope: Scope } | undefined;
  entries: Entry[];
}

export interface SummaryCollector {
  visitor: Visitor;
  /** Call after the walk. */
  finish(source: string): TestSummary;
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
  const finder = new AssertionFinder((options.assertFunctionNames ?? []).map(globToRegExp), norm);

  const imports: string[] = [];
  const frameworkImports: TestSummary['framework'][] = [];
  const mockedModules = new Set<string>();
  const tests: RawTest[] = [];
  let sawVi = false;
  let sawJest = false;
  let fileTimeout: number | undefined;

  const frames: Frame[] = [];
  /** Where assertions go: the innermost test or deferred function being walked. */
  const targets: { node: AstNode; entries: Entry[] }[] = [];
  let currentTest: RawTest | undefined;
  let currentTestNode: AstNode | undefined;

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
  const popTarget = (node: AstNode): void => {
    if (targets[targets.length - 1]?.node === node) targets.pop();
  };
  const pushScope = (): void => {
    scope = new Scope(scope);
  };
  const popScope = (): void => {
    scope = scope.parent ?? root;
  };
  const bindParams = (fn: AstNode): void => {
    const names: string[] = [];
    for (const param of children(fn, 'params')) patternNames(param, names);
    for (const name of names) scope.names.set(name, { mock: false });
  };

  /** What a value initialised from `init` is: a mock, derived from a name, or neither. */
  const classify = (initRaw: AstNode | undefined): Pick<Binding, 'mock' | 'derivedFrom'> => {
    if (!initRaw) return { mock: false };
    const init = unwrap(initRaw);
    const signals = subjectSignals(init, norm);
    const call = init.type === 'AwaitExpression' ? child(init, 'argument') : init;
    const inner = call ? unwrap(call) : undefined;
    const factory = inner?.type === 'CallExpression' ? pathOf(child(inner, 'callee')) : undefined;
    if ((factory && MOCK_FACTORIES.has(factory.join('.'))) || signals.viaMock)
      return { mock: true };
    if (signals.root) return { mock: false, derivedFrom: { scope, name: signals.root } };
    return { mock: false };
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
          if (key && value && str(key, 'name') === 'testTimeout') ms = staticNumber(value);
        }
      } else if (a) {
        ms = staticNumber(a);
      }
    } else if (joined === 'test.describe.configure') {
      const a = args[0] ? unwrap(args[0]) : undefined;
      for (const prop of a ? children(a, 'properties') : []) {
        const key = child(prop, 'key');
        const value = child(prop, 'value');
        if (key && value && str(key, 'name') === 'timeout') ms = staticNumber(value);
      }
    }
    if (ms === undefined) return;
    // Inside a test or a helper it is an effect of running that code, applied where it runs.
    if (targets.length > 0) push({ pos: call.start, timeout: ms });
    // Suite configuration applies to the whole suite wherever it appears, and the last call wins.
    else if (frames.length > 0) frames[frames.length - 1]!.timeout = ms;
    else fileTimeout = ms;
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
        if (s !== undefined) mockedModules.add(s);
      }
      if (calleePath[0] === 'vi') sawVi = true;
      if (calleePath[0] === 'jest') sawJest = true;
      timeoutCall(node, calleePath);
    }

    // describe / test declarations (not nested inside a test body)
    if (!currentTest) {
      const decl = parseDecl(node, norm);
      if (decl) {
        const name = nameOf(ctx.source, decl.nameNode);
        const mod = pickModifier(decl.modifiers);
        if (decl.kind === 'describe') {
          frames.push({
            node,
            name,
            modifier: mod,
            loc: ctx.loc(node.start),
            timeout: decl.timeout,
          });
        } else {
          const entries: Entry[] = [];
          tests.push({
            name,
            path: frames.map((f) => f.name),
            loc: ctx.loc(node.start),
            modifier: mod,
            timeout: decl.timeout,
            ancestors: [...frames],
            bodyHash: decl.fn ? hashNode(child(decl.fn, 'body')) : undefined,
            fnRef: decl.fnRef ? { node: decl.fnRef, scope } : undefined,
            entries,
          });
          currentTest = tests[tests.length - 1];
          currentTestNode = node;
          targets.push({ node, entries });
        }
        return;
      }
    }

    // assertions
    const found = finder.find(node);
    if (found) {
      push({
        pos: node.start,
        ref: found.ref,
        signals: subjectSignals(found.subject, norm),
        scope,
      });
      return;
    }

    // references that may run a local helper
    if (targets.length === 0 || !callee) return;
    const c = unwrap(callee);
    let calleeName: string | undefined;
    if (c.type === 'Identifier') {
      calleeName = str(c, 'name');
      push({ pos: node.start, call: calleeName ?? '', scope }); // check()
    } else if (c.type === 'MemberExpression' && c['computed'] !== true) {
      const object = child(c, 'object');
      const property = child(c, 'property');
      calleeName = property ? str(property, 'name') : undefined;
      const objectName =
        object && unwrap(object).type === 'Identifier' ? str(unwrap(object), 'name') : undefined;
      if (objectName && calleeName)
        push({ pos: node.start, call: objectName, method: calleeName, scope }); // page.expectOk()
    }
    // a helper passed to an API that calls it: items.forEach(check), waitFor(check)
    if (calleeName && CALLBACK_APIS.has(calleeName)) {
      for (const arg of children(node, 'arguments')) {
        const a = unwrap(arg);
        if (a.type === 'Identifier') push({ pos: a.start, call: str(a, 'name') ?? '', scope });
      }
    }
  };

  const enterFunction = (node: AstNode): void => {
    pushScope();
    bindParams(node);
  };

  /** A function value that is stored, not run: its body must not count for the enclosing test. */
  const deferFunction = (node: AstNode): HelperDef => {
    const def: HelperDef = { node, entries: [] };
    targets.push({ node, entries: def.entries });
    return def;
  };

  const visitor: Visitor = {
    ImportDeclaration(node) {
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
        const importedName = imported
          ? (str(imported, 'name') ?? staticString(imported))
          : undefined;

        if (framework) {
          if (s.type === 'ImportNamespaceSpecifier') binding.framework = { kind: 'namespace' };
          else if (s.type === 'ImportDefaultSpecifier') {
            binding.framework = { kind: 'named', imported: 'test' };
          } else if (importedName) binding.framework = { kind: 'named', imported: importedName };
        }
        if (isAssert || isStrictAssert) {
          if (s.type === 'ImportSpecifier' && importedName === 'strict') {
            finder.assertLocals.add(name);
            finder.strictLocals.add(name);
          } else if (s.type === 'ImportSpecifier' && importedName) {
            finder.assertNamed.set(name, { imported: importedName, strict: isStrictAssert });
          } else {
            finder.assertLocals.add(name);
            if (isStrictAssert) finder.strictLocals.add(name);
          }
        }
      }
    },
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
        popTarget(node);
      }
      const top = frames[frames.length - 1];
      if (top && top.node === node) frames.pop();
    },

    FunctionDeclaration(node) {
      const id = child(node, 'id');
      const name = id ? str(id, 'name') : undefined;
      // A named function is a helper: its assertions count only where it is called.
      if (name) scope.names.set(name, { mock: false, helper: deferFunction(node) });
      enterFunction(node);
    },
    'FunctionDeclaration:exit'(node) {
      popScope();
      popTarget(node);
    },
    FunctionExpression: enterFunction,
    'FunctionExpression:exit': popScope,
    ArrowFunctionExpression: enterFunction,
    'ArrowFunctionExpression:exit': popScope,

    BlockStatement: pushScope,
    'BlockStatement:exit': popScope,
    ForStatement: pushScope,
    'ForStatement:exit': popScope,
    ForInStatement: pushScope,
    'ForInStatement:exit': popScope,
    ForOfStatement: pushScope,
    'ForOfStatement:exit': popScope,
    CatchClause(node) {
      pushScope();
      const names: string[] = [];
      patternNames(child(node, 'param'), names);
      for (const name of names) scope.names.set(name, { mock: false });
    },
    'CatchClause:exit': popScope,

    VariableDeclarator(node) {
      const id = child(node, 'id');
      const initRaw = child(node, 'init');
      const names: string[] = [];
      patternNames(id, names);
      const init = initRaw ? unwrap(initRaw) : undefined;

      if (init && isFunction(init) && id?.type === 'Identifier' && names[0]) {
        scope.names.set(names[0], { mock: false, helper: deferFunction(init) });
        targets[targets.length - 1]!.node = node; // popped on the declarator's exit
        return;
      }
      const classified = classify(initRaw);
      for (const name of names) scope.names.set(name, { ...classified });
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
      const binding =
        left.type === 'Identifier' ? scope.lookup(str(left, 'name') ?? '') : undefined;
      if (isFunction(right)) {
        const def = deferFunction(right);
        targets[targets.length - 1]!.node = node;
        if (binding) binding.helper = def;
        return;
      }
      // only local bindings: assigning to an import or a global is not tracked
      if (binding && binding.importFrom === undefined) {
        const classified = classify(rightRaw);
        binding.mock = classified.mock;
        if (classified.derivedFrom) binding.derivedFrom = classified.derivedFrom;
        else delete binding.derivedFrom;
      }
    },
    'AssignmentExpression:exit': popTarget,
  };

  const finish = (source: string): TestSummary => {
    const isMock = (binding: Binding | undefined, depth = 0): boolean => {
      if (!binding || depth > 8) return false;
      if (binding.mock) return true;
      if (binding.importFrom !== undefined && mockedModules.has(binding.importFrom)) return true;
      const from = binding.derivedFrom;
      return from ? isMock(from.scope.lookup(from.name), depth + 1) : false;
    };

    const toUse = (e: Extract<Entry, { ref: MatcherRef }>): MatcherUse => {
      const resolved = lattice.resolveMatcher(e.ref);
      const rootName = e.signals.root;
      return {
        name: e.ref.name,
        strength: resolved.strength,
        negated: resolved.negated,
        subjectIsMock:
          e.signals.viaMock || (rootName !== undefined && isMock(e.scope.lookup(rootName))),
      };
    };

    const helperOf = (e: Extract<Entry, { call: string }>): HelperDef | undefined => {
      const binding = e.scope.lookup(e.call);
      return e.method === undefined ? binding?.helper : binding?.methods?.get(e.method);
    };

    /** Matchers and timeout effects of some code, with helper calls followed `follow` level(s). */
    const expand = (
      entries: readonly Entry[],
      out: { uses: MatcherUse[]; timeout?: number },
      follow: boolean,
    ): void => {
      for (const entry of [...entries].sort((a, b) => a.pos - b.pos)) {
        if ('ref' in entry) out.uses.push(toUse(entry));
        else if ('timeout' in entry) out.timeout = entry.timeout;
        else if (follow) {
          const def = helperOf(entry);
          if (def) expand(def.entries, out, false);
        }
      }
    };

    const used = new Set<string>();
    const counters = new Map<string, number>();
    const cases: TestCase[] = tests.map((t) => {
      const out: { uses: MatcherUse[]; timeout?: number } = { uses: [] };
      // `test('x', namedFn)`: the named function is the test body, so it is expanded exactly like
      // an inline body, with one level of helper calls.
      const callback = t.fnRef
        ? t.fnRef.scope.lookup(str(t.fnRef.node, 'name') ?? '')?.helper
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

      const tc: TestCase = { id, loc: t.loc, matchers: out.uses, bodyHash };
      const inheritedFrom = [...t.ancestors].reverse().find((f) => f.modifier);
      const modifier = t.modifier ?? inheritedFrom?.modifier;
      if (modifier) {
        tc.modifier = modifier;
        const at = t.modifier ? t.loc : inheritedFrom?.loc;
        if (at) tc.modifierLoc = at;
      }
      const timeout =
        out.timeout ??
        t.timeout ??
        [...t.ancestors].reverse().find((f) => f.timeout !== undefined)?.timeout ??
        fileTimeout;
      if (timeout !== undefined) tc.timeoutMs = timeout;
      return tc;
    });

    const framework: TestSummary['framework'] =
      frameworkImports[0] ?? (sawVi ? 'vitest' : sawJest ? 'jest' : 'unknown');
    return { hash: hashText(source), framework, imports, tests: cases };
  };

  return { visitor, finish };
}
