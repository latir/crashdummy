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
export const SUMMARY_VERSION = 1;

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

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

/** Find the dotted path of a declaration callee, looking through `.each(table)` and templates. */
function declPath(callee: AstNode): string[] | undefined {
  const c = unwrap(callee);
  if (c.type === 'TaggedTemplateExpression') {
    const tag = child(c, 'tag');
    return tag ? declPath(tag) : undefined;
  }
  if (c.type === 'CallExpression') {
    const inner = child(c, 'callee');
    const path = inner ? memberPath(inner) : undefined;
    const last = path?.[path.length - 1];
    if (path && last !== undefined && (TABLE_WORDS.has(last) || CONDITIONAL_WORDS.has(last))) {
      return path;
    }
    return undefined;
  }
  return memberPath(c);
}

function parseDecl(call: AstNode): Decl | undefined {
  const callee = child(call, 'callee');
  if (!callee) return undefined;
  const path = declPath(callee);
  if (!path) return undefined;

  let segments = path;
  let base = BASES[segments[0] ?? ''];
  if (!base) return undefined;
  let kind = base.kind;
  const modifiers: TestModifier[] = base.modifier ? [base.modifier] : [];
  segments = segments.slice(1);

  // Playwright: test.describe, test.describe.skip, ...
  if (segments[0] === 'describe' && segments[0] !== undefined && path[0] === 'test') {
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
  const second = args[1] ? unwrap(args[1]) : undefined;
  const fnRef =
    !fn && staticString(nameNode) !== undefined && second?.type === 'Identifier'
      ? second
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

const KNOWN_FLAGS = new Set(['concurrent', 'sequential', 'serial', 'parallel', 'slow', 'shuffle']);

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

function argKind(arg: AstNode | undefined): ArgKind {
  if (!arg) return 'none';
  const a = unwrap(arg);
  if (a.type === 'CallExpression') {
    const callee = child(a, 'callee');
    const path = callee ? memberPath(callee) : undefined;
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

class AssertionFinder {
  /** Locals bound to the default or namespace import of `node:assert`. */
  readonly assertLocals = new Set<string>(['assert']);
  /** `import { strictEqual } from 'node:assert'` -> local name to imported name. */
  readonly assertNamed = new Map<string, string>();

  constructor(private readonly custom: readonly RegExp[]) {}

  find(call: AstNode): Assertion | undefined {
    const callee = child(call, 'callee');
    if (!callee) return undefined;
    const c = unwrap(callee);
    const args = children(call, 'arguments');

    if (c.type === 'MemberExpression') {
      const chain = this.expectChain(c, args);
      if (chain) return chain;
    }

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
    const root = expectCallee ? memberPath(expectCallee)?.join('.') : undefined;
    if (!root || !EXPECT_ROOTS.has(root)) return undefined;

    const subject = children(obj, 'arguments')[0];
    return {
      ref: { name: matcher, negated, arg: argKind(args[0]), modifiers },
      subject: root === 'expect.poll' ? undefined : subject,
    };
  }

  private assertCall(path: string[], args: AstNode[]): Assertion | undefined {
    let p = path;
    if (p[0] === 't' && p[1] === 'assert') p = p.slice(1); // node:test's t.assert.*
    let name: string | undefined;
    if (p.length === 1 && this.assertNamed.has(p[0]!)) {
      name = `assert.${this.assertNamed.get(p[0]!)}`;
    } else if (this.assertLocals.has(p[0] ?? '') && (p[0] !== 't' || path[0] === 't')) {
      const rest = p.slice(1).filter((s) => s !== 'strict');
      name = rest.length === 0 ? 'assert' : rest.length === 1 ? `assert.${rest[0]}` : undefined;
    }
    if (!name) return undefined;
    const argIndex = ASSERT_CALLEE_ARG[name] ?? 0;
    return { ref: { name, arg: argKind(args[argIndex]) }, subject: args[0] };
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

function subjectSignals(subject: AstNode | undefined): SubjectSignals {
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
      const path = callee ? memberPath(callee) : undefined;
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
  'optional',
]);

/** Hash of an AST subtree that ignores positions, comments, formatting and type annotations. */
export function hashNode(node: AstNode | undefined): string {
  const h = createHash('sha1');
  const feed = (v: unknown): void => {
    if (Array.isArray(v)) {
      h.update('[');
      for (const x of v) feed(x);
      h.update(']');
    } else if (typeof v === 'object' && v !== null) {
      const obj = v as Record<string, unknown>;
      if (typeof obj['type'] === 'string' && (obj['type'] as string).startsWith('TS')) {
        const wrapped = obj['expression'];
        if (wrapped !== undefined) feed(wrapped); // `x as T` hashes like `x`
        return;
      }
      h.update('{');
      for (const key of Object.keys(obj)) {
        if (HASH_SKIP.has(key)) continue;
        h.update(key);
        h.update(':');
        feed(obj[key]);
      }
      h.update('}');
    } else {
      h.update(typeof v === 'bigint' ? `${v}n` : String(v));
      h.update(',');
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
const ASSERT_MODULES = new Set(['assert', 'assert/strict', 'node:assert', 'node:assert/strict']);

// ---------------------------------------------------------------------------------------------
// The collector

interface Frame {
  node: AstNode;
  kind: 'describe' | 'test';
  name: string;
  modifier: TestModifier | undefined;
  timeout: number | undefined;
}

type Entry =
  { pos: number; ref: MatcherRef; signals: SubjectSignals } | { pos: number; helper: string };

interface RawTest {
  name: string;
  path: string[];
  loc: { line: number; col: number };
  modifier: TestModifier | undefined;
  inheritedModifier: TestModifier | undefined;
  timeout: number | undefined;
  inheritedTimeout: number | undefined;
  bodyHash: string;
  entries: Entry[];
}

export interface SummaryCollector {
  visitor: Visitor;
  /** Call after the walk. */
  finish(source: string): TestSummary;
}

export function createSummaryCollector(options: SummaryOptions = {}): SummaryCollector {
  const lattice: Lattice = createLattice(options.matchers ?? {});
  const finder = new AssertionFinder((options.assertFunctionNames ?? []).map(globToRegExp));

  const imports: string[] = [];
  const frameworkImports: TestSummary['framework'][] = [];
  const bindings = new Map<string, string>(); // local name -> module specifier
  const mockedModules = new Set<string>();
  const mockFactoryVars = new Set<string>();
  const derivedVars: { name: string; root: string }[] = [];
  const helpers = new Map<string, Entry[]>();
  const tests: RawTest[] = [];
  let sawVi = false;
  let sawJest = false;
  let fileTimeout: number | undefined;

  const frames: Frame[] = [];
  const helperStack: { node: AstNode; name: string; entries: Entry[] }[] = [];
  let currentTest: RawTest | undefined;
  let currentTestNode: AstNode | undefined;

  const addImport = (spec: string | undefined): void => {
    if (spec !== undefined && !imports.includes(spec)) imports.push(spec);
  };

  const describePath = (): string[] =>
    frames.filter((f) => f.kind === 'describe').map((f) => f.name);
  const inherited = <K extends 'modifier' | 'timeout'>(key: K): Frame[K] | undefined => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const v = frames[i]![key];
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const nameOf = (source: string, node: AstNode): string => {
    return staticString(node) ?? sourceText(source, unwrap(node));
  };

  const route = (entry: Entry): void => {
    if (currentTest) currentTest.entries.push(entry);
    else helperStack[helperStack.length - 1]?.entries.push(entry);
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
    if (currentTest) currentTest.timeout = ms;
    else if (frames.length > 0) frames[frames.length - 1]!.timeout ??= ms;
    else fileTimeout = ms;
  };

  const onCall = (node: AstNode, ctx: WalkContext): void => {
    const callee = child(node, 'callee');
    const calleePath = callee ? memberPath(callee) : undefined;

    // require('x') and vi.mock('x')
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
      const decl = parseDecl(node);
      if (decl) {
        const name = nameOf(ctx.source, decl.nameNode);
        const mod = pickModifier(decl.modifiers);
        if (decl.kind === 'describe') {
          frames.push({ node, kind: 'describe', name, modifier: mod, timeout: decl.timeout });
        } else {
          const entries: Entry[] = [];
          const raw: RawTest = {
            name,
            path: describePath(),
            loc: ctx.loc(node.start),
            modifier: mod,
            inheritedModifier: inherited('modifier'),
            timeout: decl.timeout,
            inheritedTimeout: inherited('timeout'),
            bodyHash: hashNode((decl.fn?.['body'] ?? decl.fnRef) as AstNode | undefined),
            entries,
          };
          if (decl.fnRef) {
            entries.push({ pos: decl.fnRef.start, helper: str(decl.fnRef, 'name') ?? '' });
          }
          tests.push(raw);
          currentTest = raw;
          currentTestNode = node;
        }
        return;
      }
    }

    // assertions
    const found = finder.find(node);
    if (found) {
      route({ pos: node.start, ref: found.ref, signals: subjectSignals(found.subject) });
      return;
    }

    // calls to local helpers, followed one level deep when the summary is finished
    if (currentTest && callee) {
      const c = unwrap(callee);
      if (c.type === 'Identifier')
        currentTest.entries.push({ pos: node.start, helper: str(c, 'name') ?? '' });
    }
  };

  const visitor: Visitor = {
    ImportDeclaration(node) {
      const src = child(node, 'source');
      const spec = src ? staticString(src) : undefined;
      if (spec === undefined || str(node, 'importKind') === 'type') return;
      addImport(spec);
      const fw = FRAMEWORK_MODULES[spec];
      if (fw) frameworkImports.push(fw);
      for (const s of children(node, 'specifiers')) {
        const local = child(s, 'local');
        const name = local ? str(local, 'name') : undefined;
        if (!name) continue;
        bindings.set(name, spec);
        if (ASSERT_MODULES.has(spec)) {
          if (s.type === 'ImportSpecifier') {
            const imported = child(s, 'imported');
            const importedName = imported ? str(imported, 'name') : undefined;
            if (importedName) finder.assertNamed.set(name, importedName);
          } else {
            finder.assertLocals.add(name);
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
      }
      const top = frames[frames.length - 1];
      if (top && top.node === node) frames.pop();
    },

    FunctionDeclaration(node) {
      const id = child(node, 'id');
      const name = id ? str(id, 'name') : undefined;
      if (name && !currentTest) helperStack.push({ node, name, entries: [] });
    },
    'FunctionDeclaration:exit'(node) {
      const top = helperStack[helperStack.length - 1];
      if (top && top.node === node) {
        helpers.set(top.name, top.entries);
        helperStack.pop();
      }
    },
    VariableDeclarator(node) {
      const id = child(node, 'id');
      const initRaw = child(node, 'init');
      const name = id && id.type === 'Identifier' ? str(id, 'name') : undefined;
      if (!name || !initRaw) return;
      const init = unwrap(initRaw);
      if (isFunction(init)) {
        if (!currentTest) helperStack.push({ node, name, entries: [] });
        return;
      }
      const signals = subjectSignals(init);
      const call = init.type === 'AwaitExpression' ? child(init, 'argument') : init;
      const callee =
        call && unwrap(call).type === 'CallExpression' ? child(unwrap(call), 'callee') : undefined;
      const path = callee ? memberPath(callee) : undefined;
      if (path && MOCK_FACTORIES.has(path.join('.'))) mockFactoryVars.add(name);
      else if (signals.viaMock) mockFactoryVars.add(name);
      else if (signals.root) derivedVars.push({ name, root: signals.root });
    },
    'VariableDeclarator:exit'(node) {
      const top = helperStack[helperStack.length - 1];
      if (top && top.node === node) {
        helpers.set(top.name, top.entries);
        helperStack.pop();
      }
    },
  };

  const finish = (source: string): TestSummary => {
    // Names that are mocks: factory results, imports of mocked modules, and values derived from them.
    const mocks = new Set(mockFactoryVars);
    for (const [local, spec] of bindings) if (mockedModules.has(spec)) mocks.add(local);
    for (let changed = true, pass = 0; changed && pass < 5; pass++) {
      changed = false;
      for (const d of derivedVars) {
        if (mocks.has(d.root) && !mocks.has(d.name)) {
          mocks.add(d.name);
          changed = true;
        }
      }
    }

    const toUse = (e: Extract<Entry, { ref: MatcherRef }>): MatcherUse => {
      const resolved = lattice.resolveMatcher(e.ref);
      return {
        name: e.ref.name,
        strength: resolved.strength,
        negated: resolved.negated,
        subjectIsMock:
          e.signals.viaMock || (e.signals.root !== undefined && mocks.has(e.signals.root)),
      };
    };

    const seen = new Map<string, number>();
    const cases: TestCase[] = tests.map((t) => {
      // Flatten helper calls (one level deep) into the call site, in order of appearance.
      const flat: MatcherUse[] = [];
      for (const entry of [...t.entries].sort((a, b) => a.pos - b.pos)) {
        if ('ref' in entry) flat.push(toUse(entry));
        else {
          const helper = helpers.get(entry.helper);
          if (helper) {
            for (const inner of [...helper].sort((a, b) => a.pos - b.pos)) {
              if ('ref' in inner) flat.push(toUse(inner));
            }
          }
        }
      }
      const base = [...t.path, t.name].join(' > ');
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const tc: TestCase = {
        id: n === 1 ? base : `${base} #${n}`,
        loc: t.loc,
        matchers: flat,
        bodyHash: t.bodyHash,
      };
      const modifier = t.modifier ?? t.inheritedModifier;
      if (modifier) tc.modifier = modifier;
      const timeout = t.timeout ?? t.inheritedTimeout ?? fileTimeout;
      if (timeout !== undefined) tc.timeoutMs = timeout;
      return tc;
    });

    const framework: TestSummary['framework'] =
      frameworkImports[0] ?? (sawVi ? 'vitest' : sawJest ? 'jest' : 'unknown');
    return { hash: hashText(source), framework, imports, tests: cases };
  };

  return { visitor, finish };
}
