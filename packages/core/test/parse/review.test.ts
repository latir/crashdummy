import { describe, expect, test } from 'vitest';
import { summarize, shape } from './helpers.js';

/** Regression tests for the review of the parser: each block names the failure it prevents. */

const sum = (src: string, options = {}) => summarize('a.test.ts', src, options);

describe('nested functions count only when they run', () => {
  test('an uncalled nested arrow function does not count as an assertion', () => {
    const s = sum(`test('x', () => { const unused = () => expect(1).toBe(1); });`);
    expect(shape(s)).toEqual({ x: [] });
  });

  test('an uncalled nested function declaration does not count either', () => {
    const s = sum(`test('x', () => { function unused() { expect(1).toBe(1); } });`);
    expect(shape(s)).toEqual({ x: [] });
  });

  test('a called nested function counts, at the call site', () => {
    const s = sum(`test('x', () => {
      const check = () => expect(1).toBe(1);
      expect(0).toEqual(0);
      check();
    });`);
    expect(shape(s)).toEqual({ x: ['toEqual:4', 'toBe:4'] });
  });

  test('a nested function passed by reference counts', () => {
    const s = sum(
      `test('x', () => { const check = (n) => expect(n).toBe(1); [1].forEach(check); });`,
    );
    expect(shape(s)).toEqual({ x: ['toBe:4'] });
  });

  test('anonymous callbacks run inline: test.step, forEach, then', () => {
    const s = sum(`test('x', async () => {
      await test.step('s', async () => { expect(1).toBe(1); });
      [1].forEach((n) => expect(n).toEqual(1));
      await p.then(() => expect(2).toBeTruthy());
    });`);
    expect(shape(s)).toEqual({ x: ['toBe:4', 'toEqual:4', 'toBeTruthy:1'] });
  });
});

describe('ids are unique', () => {
  test('a title that already looks like a suffixed id does not collide', () => {
    const s = sum(`test('x', () => {}); test('x', () => {}); test('x #2', () => {});`);
    const ids = s.tests.map((t) => t.id);
    expect(ids).toEqual(['x', 'x #2', 'x #2 #2']);
    expect(new Set(ids).size).toBe(3);
  });

  test('stays unique in any order', () => {
    const s = sum(
      `test('x #2', () => {}); test('x', () => {}); test('x', () => {}); test('x', () => {});`,
    );
    const ids = s.tests.map((t) => t.id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('runtime TypeScript', () => {
  test('tests inside a namespace are found', () => {
    const s = sum(`namespace Suite { test('inside', () => { expect(1).toBe(1); }); }`);
    expect(shape(s)).toEqual({ inside: ['toBe:4'] });
  });

  test('tests inside a `declare` block are not code', () => {
    const s = sum(`declare namespace Suite { const a: number; }\ntest('real', () => {});`);
    expect(s.tests.map((t) => t.id)).toEqual(['real']);
  });

  test('enum values are part of the body hash', () => {
    const hash = (value: number) =>
      sum(`test('x', () => { enum E { A = ${value} } expect(E.A).toBe(1); });`).tests[0]!.bodyHash;
    expect(hash(1)).not.toBe(hash(2));
    expect(hash(1)).toBe(hash(1));
  });

  test('type-only code does not change the body hash', () => {
    const a = sum(`test('x', () => { expect(1).toBe(1); });`).tests[0]!.bodyHash;
    const b = sum(
      `test('x', () => { type T = number; interface I { a: string } expect(1 as T).toBe(1); });`,
    ).tests[0]!.bodyHash;
    expect(a).toBe(b);
  });
});

describe('strict node:assert', () => {
  test.each([
    [
      `import assert from 'node:assert/strict'; test('x', () => { assert.equal(1, 1); });`,
      'assert.strictEqual:4',
    ],
    [
      `import assert from 'node:assert'; test('x', () => { assert.strict.equal(1, 1); });`,
      'assert.strictEqual:4',
    ],
    [
      `import { strict as assert } from 'node:assert'; test('x', () => { assert.equal(1, 1); });`,
      'assert.strictEqual:4',
    ],
    [
      `import { equal } from 'node:assert/strict'; test('x', () => { equal(1, 1); });`,
      'assert.strictEqual:4',
    ],
    [
      `import { deepEqual } from 'node:assert/strict'; test('x', () => { deepEqual(1, 1); });`,
      'assert.deepStrictEqual:4',
    ],
    [
      `import assert from 'node:assert/strict'; test('x', () => { assert.notEqual(1, 2); });`,
      '!assert.notStrictEqual:2',
    ],
    // loose mode stays loose
    [
      `import assert from 'node:assert'; test('x', () => { assert.equal(1, 1); });`,
      'assert.equal:3',
    ],
    [`import { equal } from 'node:assert'; test('x', () => { equal(1, 1); });`, 'assert.equal:3'],
  ])('%s', (source, expected) => {
    expect(shape(sum(source)).x).toEqual([expected]);
  });

  test('switching the import from strict to loose weakens the recorded matcher', () => {
    const strict = shape(
      sum(`import assert from 'node:assert/strict'; test('x', () => { assert.equal(1, 1); });`),
    ).x;
    const loose = shape(
      sum(`import assert from 'node:assert'; test('x', () => { assert.equal(1, 1); });`),
    ).x;
    expect(strict).not.toEqual(loose);
  });
});

describe('body hash keeps primitive types', () => {
  const hash = (literal: string) =>
    sum(`test('x', () => { expect(f()).toBe(${literal}); });`).tests[0]!.bodyHash;

  test.each([
    ['1', "'1'"],
    ['true', "'true'"],
    ['null', "'null'"],
    ['0', 'false'],
    ['1n', '1'],
  ])('%s differs from %s', (a, b) => {
    expect(hash(a)).not.toBe(hash(b));
  });

  test('equal values still match', () => {
    expect(hash("'a'")).toBe(hash('"a"'));
  });
});

describe('mocks are tracked by lexical binding', () => {
  test('the same name in two tests is judged separately', () => {
    const s = sum(`
      function realFn() {}
      test('mock', () => { const result = vi.fn(); expect(result).toHaveBeenCalled(); });
      test('real', () => { const result = realFn(); expect(result).toBe(1); });
    `);
    expect(shape(s)).toEqual({
      mock: ['toHaveBeenCalled:2@mock'],
      real: ['toBe:4'],
    });
  });

  test('a derived value is judged by its own scope', () => {
    const s = sum(`
      const mockFn = vi.fn();
      test('derived', () => { const out = mockFn(); expect(out).toBe(1); });
      test('shadowed', () => { const mockFn = realFn; const out = mockFn(); expect(out).toBe(1); });
    `);
    expect(shape(s)).toEqual({ derived: ['toBe:4@mock'], shadowed: ['toBe:4'] });
  });

  test('a parameter shadows an outer mock', () => {
    const s = sum(`
      const result = vi.fn();
      test('x', () => { [1].forEach((result) => expect(result).toBe(1)); expect(result).toHaveBeenCalled(); });
    `);
    expect(shape(s)).toEqual({ x: ['toBe:4', 'toHaveBeenCalled:2@mock'] });
  });

  test('a shadowed import is not a mock', () => {
    const s = sum(`
      import { api } from './api';
      vi.mock('./api');
      test('imported', () => { expect(api()).toBe(1); });
      test('shadowed', () => { const api = () => 1; expect(api()).toBe(1); });
    `);
    expect(shape(s)).toEqual({ imported: ['toBe:4@mock'], shadowed: ['toBe:4'] });
  });
});

describe('helpers are resolved by lexical scope', () => {
  test('two describes with a same-named helper keep their own', () => {
    const s = sum(`
      describe('a', () => {
        function check() { expect(1).toBe(1); }
        test('uses a', () => { check(); });
      });
      describe('b', () => {
        function check() {}
        test('uses b', () => { check(); });
      });
    `);
    expect(shape(s)).toEqual({ 'a > uses a': ['toBe:4'], 'b > uses b': [] });
  });

  test('a helper declared after the test that calls it is found', () => {
    const s = sum(`
      test('early', () => { later(); });
      function later() { expect(1).toBe(1); }
      const arrowLater = () => { expect(2).toEqual(2); };
      test('arrow', () => { arrowLater(); });
    `);
    expect(shape(s)).toEqual({ early: ['toBe:4'], arrow: ['toEqual:4'] });
  });

  test('a test-local helper shadows a module helper', () => {
    const s = sum(`
      function check() { expect(1).toBe(1); }
      test('x', () => { const check = () => {}; check(); });
    `);
    expect(shape(s)).toEqual({ x: [] });
  });
});

describe('suite configuration reaches every test in the suite', () => {
  test('describe.configure after the tests still applies, and the last call wins', () => {
    const s = sum(`
      import { test } from '@playwright/test';
      test.describe('s', () => {
        test('before', async () => {});
        test.describe.configure({ timeout: 1000 });
        test('after', async () => {});
        test.describe.configure({ timeout: 5000 });
      });
    `);
    expect(s.tests.map((t) => t.timeoutMs)).toEqual([5000, 5000]);
  });

  test('a test timeout still wins over the suite', () => {
    const s = sum(`
      test.describe('s', () => {
        test.describe.configure({ timeout: 5000 });
        test('own', { timeout: 100 }, async () => {});
        test('inherits', async () => {});
      });
    `);
    expect(s.tests.map((t) => t.timeoutMs)).toEqual([100, 5000]);
  });

  test('an inner suite overrides an outer one', () => {
    const s = sum(`
      test.describe('outer', () => {
        test.describe.configure({ timeout: 9000 });
        test.describe('inner', () => {
          test.describe.configure({ timeout: 2000 });
          test('t', async () => {});
        });
        test('o', async () => {});
      });
    `);
    expect(s.tests.map((t) => [t.id, t.timeoutMs])).toEqual([
      ['outer > inner > t', 2000],
      ['outer > o', 9000],
    ]);
  });
});

describe('named callbacks hash their real body', () => {
  const hashOf = (src: string) => sum(src).tests[0]!.bodyHash;

  test('editing the referenced function changes the hash', () => {
    const a = hashOf(`function body() { expect(1).toBe(1); }\ntest('x', body);`);
    const b = hashOf(`function body() { expect(1).toBe(2); }\ntest('x', body);`);
    expect(a).not.toBe(b);
  });

  test('renaming the function does not', () => {
    const a = hashOf(`function body() { expect(1).toBe(1); }\ntest('x', body);`);
    const b = hashOf(`function renamed() { expect(1).toBe(1); }\ntest('x', renamed);`);
    expect(a).toBe(b);
  });

  test('matches an inline test with the same body', () => {
    const named = hashOf(`function body() { expect(1).toBe(1); }\ntest('x', body);`);
    const inline = hashOf(`test('x', () => { expect(1).toBe(1); });`);
    expect(named).toBe(inline);
  });

  test('a function declared after the test is found', () => {
    const a = hashOf(`test('x', body);\nfunction body() { expect(1).toBe(1); }`);
    const b = hashOf(`test('x', body);\nfunction body() { expect(1).toBe(2); }`);
    expect(a).not.toBe(b);
  });

  test('an imported callback falls back to its name', () => {
    expect(hashOf(`import { body } from './b'; test('x', body);`)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('aliased framework imports', () => {
  test('aliased test and expect', () => {
    const s = sum(`import { test as spec, expect as check, describe as suite } from 'vitest';
      suite('s', () => { spec('x', () => { check(1).toBe(1); }); });`);
    expect(shape(s)).toEqual({ 's > x': ['toBe:4'] });
    expect(s.framework).toBe('vitest');
  });

  test('aliasing only expect', () => {
    const s = sum(
      `import { test, expect as check } from 'vitest'; test('x', () => { check(1).toBe(1); });`,
    );
    expect(shape(s)).toEqual({ x: ['toBe:4'] });
  });

  test('aliased modifiers and vi', () => {
    const s = sum(`import { it as spec, vi as mocker } from 'vitest';
      vi.mock('./a');
      const fn = mocker.fn();
      spec.skip('x', () => { expect(fn).toHaveBeenCalled(); });`);
    expect(s.tests[0]).toMatchObject({ modifier: 'skip' });
    expect(s.tests[0]!.matchers[0]).toMatchObject({ subjectIsMock: true });
  });

  test('a namespace import', () => {
    const s = sum(`import * as t from 'vitest'; t.test('x', () => { t.expect(1).toBe(1); });`);
    expect(shape(s)).toEqual({ x: ['toBe:4'] });
  });

  test('a default import of node:test', () => {
    const s = sum(`import it from 'node:test'; it('x', () => {});`);
    expect(s.tests.map((t) => t.id)).toEqual(['x']);
    expect(s.framework).toBe('node-test');
  });

  test('an import-only refactor does not change the summary', () => {
    const plain = sum(
      `import { test, expect } from 'vitest'; test('x', () => { expect(1).toBe(1); });`,
    );
    const aliased = sum(
      `import { test as spec, expect as check } from 'vitest'; spec('x', () => { check(1).toBe(1); });`,
    );
    expect(shape(aliased)).toEqual(shape(plain));
    expect(aliased.tests.map((t) => t.id)).toEqual(plain.tests.map((t) => t.id));
  });
});

describe('second review', () => {
  describe('a named callback after an options object', () => {
    test('is still a test', () => {
      const s = sum(`function body() { expect(1).toBe(1); }\ntest('x', { timeout: 1000 }, body);`);
      expect(s.tests).toHaveLength(1);
      expect(s.tests[0]).toMatchObject({ id: 'x', timeoutMs: 1000 });
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });

    test('works with a modifier option and a numeric timeout', () => {
      const s = sum(`function a() {}\nfunction b() {}
        test('skipped', { skip: true }, a);\ntest('timed', b, 500);`);
      expect(s.tests.map((t) => [t.id, t.modifier, t.timeoutMs])).toEqual([
        ['skipped', 'skip', undefined],
        ['timed', undefined, 500],
      ]);
    });
  });

  describe('optional chaining is part of the hash', () => {
    const hash = (body: string) => sum(`test('x', () => { ${body} });`).tests[0]!.bodyHash;

    test('obj?.method() and obj.method?.() differ', () => {
      expect(hash('expect(obj?.method()).toBe(1);')).not.toBe(
        hash('expect(obj.method?.()).toBe(1);'),
      );
      expect(hash('expect(obj?.a).toBe(1);')).not.toBe(hash('expect(obj.a).toBe(1);'));
    });

    test('type-level optional markers are still ignored', () => {
      expect(hash('const f = (a?: number) => a; expect(f()).toBe(1);')).toBe(
        hash('const f = (a: number) => a; expect(f()).toBe(1);'),
      );
    });
  });

  describe('local names shadow framework names', () => {
    test('a local function with an aliased framework name is not the framework', () => {
      const s = sum(`import { test, expect as check } from 'vitest';
        test('x', () => { const check = () => ({ toBe() {} }); check(1).toBe(1); });`);
      expect(shape(s)).toEqual({ x: [] });
    });

    test('a local expect is not the global one', () => {
      const s = sum(
        `function expect() { return { toBe() {} }; }\ntest('x', () => { expect(1).toBe(1); });`,
      );
      expect(shape(s)).toEqual({ x: [] });
    });

    test('a shadowed namespace import', () => {
      const s = sum(`import * as t from 'vitest';
        t.test('x', () => { const t = { expect: () => ({ toBe() {} }) }; t.expect(1).toBe(1); });`);
      expect(shape(s)).toEqual({ x: [] });
    });

    test('a shadowed mock alias does not mark a subject as a mock', () => {
      const s = sum(`import { test, expect, vi as mocker } from 'vitest';
        test('real', () => { const mocker = { fn: () => 1 }; const f = mocker.fn(); expect(f).toBeDefined(); });
        test('mock', () => { const f = mocker.fn(); expect(f).toBeDefined(); });`);
      expect(shape(s)).toEqual({ real: ['toBeDefined:1'], mock: ['toBeDefined:1@mock'] });
    });

    test('an unshadowed alias still works inside nested functions', () => {
      const s = sum(`import { test, expect as check } from 'vitest';
        test('x', () => { [1].forEach((n) => { check(n).toBe(1); }); });`);
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });

    test('a parameter named like the alias shadows it', () => {
      const s = sum(`import { test, expect as check } from 'vitest';
        test('x', () => { [(check) => check(1).toBe(1)].forEach((f) => f(() => ({ toBe() {} }))); });`);
      expect(shape(s)).toEqual({ x: [] });
    });

    test('custom assertion helpers on a local object are still found', () => {
      const s = sum(`const helpers = makeHelpers();\ntest('x', () => { helpers.expectOk(1); });`, {
        assertFunctionNames: ['helpers.expect*'],
      });
      expect(shape(s)).toEqual({ x: ['helpers.expectOk:2'] });
    });

    test('a required assert is still recognised', () => {
      const s = sum(
        `const assert = require('node:assert');\ntest('x', () => { assert.equal(1, 1); });`,
      );
      expect(shape(s)).toEqual({ x: ['assert.equal:3'] });
    });

    test('imports from other test libraries are still recognised by name', () => {
      const s = sum(
        `import { test, expect } from 'bun:test';\ntest('x', () => { expect(1).toBe(1); });`,
      );
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });
  });

  describe('timeouts belong to the code that runs them', () => {
    test('an uncalled function does not change the test timeout or the file default', () => {
      const s = sum(
        `function unused() { test.setTimeout(30000); }\ntest('x', () => {});\ntest('y', () => {});`,
      );
      expect(s.tests.map((t) => t.timeoutMs)).toEqual([undefined, undefined]);
    });

    test('a named callback sets the timeout of its own test only', () => {
      const s = sum(`function body() { test.setTimeout(2000); expect(1).toBe(1); }
        test('x', body);\ntest('y', () => {});`);
      expect(s.tests.map((t) => t.timeoutMs)).toEqual([2000, undefined]);
    });

    test('a helper that a test calls applies its timeout to that test', () => {
      const s = sum(`function slow() { test.setTimeout(9000); }
        test('calls it', () => { slow(); });\ntest('does not', () => {});`);
      expect(s.tests.map((t) => t.timeoutMs)).toEqual([9000, undefined]);
    });

    test('the last timeout set in a body wins over the declaration', () => {
      const s = sum(`test('x', { timeout: 100 }, () => { test.setTimeout(700); });`);
      expect(s.tests[0]!.timeoutMs).toBe(700);
    });
  });

  describe('passing a helper is not running it', () => {
    test('a mock factory or an unknown function does not run its argument', () => {
      const s = sum(
        `test('x', () => { const check = () => expect(1).toBe(1); vi.fn(check); register(check); });`,
      );
      expect(shape(s)).toEqual({ x: [] });
    });

    test.each([
      ['[1].forEach(check)'],
      ['[1].map(check)'],
      ['promise.then(check)'],
      ['await waitFor(check)'],
      ['await test.step("s", check)'],
    ])('%s runs it', (call) => {
      const s = sum(`test('x', async () => { const check = () => expect(1).toBe(1); ${call}; });`);
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });
  });

  describe('functions stored in objects and classes run only when called', () => {
    test('uncalled object methods and function properties do not count', () => {
      const s = sum(`test('x', () => {
        const unused = { check: () => expect(1).toBe(1), method() { expect(2).toBe(2); } };
      });`);
      expect(shape(s)).toEqual({ x: [] });
    });

    test('a class method does not count unless something calls it', () => {
      const s = sum(
        `class Page { check() { expect(1).toBe(1); } }\ntest('x', () => { new Page(); });`,
      );
      expect(shape(s)).toEqual({ x: [] });
    });

    test('obj.method() runs the method of a local object, and only that method', () => {
      const s = sum(`const page = {
          expectOk() { expect(1).toBe(1); },
          expectOther: () => { expect(2).toEqual(2); },
        };
        test('calls one', () => { page.expectOk(); });
        test('calls the other', () => { page.expectOther(); });
        test('calls none', () => { page.goto(); });`);
      expect(shape(s)).toEqual({
        'calls one': ['toBe:4'],
        'calls the other': ['toEqual:4'],
        'calls none': [],
      });
    });

    test('a function assigned to a member is isolated too', () => {
      const s = sum(`test('x', () => { const o = {}; o.check = () => expect(1).toBe(1); });`);
      expect(shape(s)).toEqual({ x: [] });
    });
  });

  describe('assignments after the declaration', () => {
    test('let fn; fn = vi.fn() is a mock like const fn = vi.fn()', () => {
      const s = sum(`test('x', () => { let fn; fn = vi.fn(); expect(fn).toBeDefined(); });`);
      expect(shape(s)).toEqual({ x: ['toBeDefined:1@mock'] });
    });

    test('a value assigned from a mock call is derived from it', () => {
      const s = sum(
        `const m = vi.fn();\ntest('x', () => { let out; out = m(); expect(out).toBe(1); });`,
      );
      expect(shape(s)).toEqual({ x: ['toBe:4@mock'] });
    });

    test('reassigning to a real value clears the mock', () => {
      const s = sum(
        `test('x', () => { let fn = vi.fn(); fn = realFn; expect(fn).toBeDefined(); });`,
      );
      expect(shape(s)).toEqual({ x: ['toBeDefined:1'] });
    });

    test('a helper assigned later is a helper', () => {
      const s = sum(`test('x', () => { let check; check = () => expect(1).toBe(1); check(); });`);
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });

    test('an assigned function that is never called does not count', () => {
      const s = sum(`test('x', () => { let check; check = () => expect(1).toBe(1); });`);
      expect(shape(s)).toEqual({ x: [] });
    });
  });

  describe('a named callback expands like an inline body', () => {
    test('helpers it calls are followed one level', () => {
      const s = sum(`function check() { expect(1).toBe(1); }
        function body() { check(); expect(2).toEqual(2); }
        test('x', body);`);
      expect(shape(s)).toEqual({ x: ['toBe:4', 'toEqual:4'] });
    });

    test('matches the inline equivalent', () => {
      const named = sum(
        `function check() { expect(1).toBe(1); }\nfunction body() { check(); }\ntest('x', body);`,
      );
      const inline = sum(`function check() { expect(1).toBe(1); }\ntest('x', () => { check(); });`);
      expect(shape(named)).toEqual(shape(inline));
    });

    test('still stops after one level', () => {
      const s = sum(`function deep() { expect(1).toBe(1); }
        function check() { deep(); }
        function body() { check(); }
        test('x', body);`);
      expect(shape(s)).toEqual({ x: [] });
    });

    test('helpers declared after the test are found', () => {
      const s = sum(
        `test('x', body);\nfunction body() { check(); }\nfunction check() { expect(1).toBe(1); }`,
      );
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });
  });
});

describe('third review', () => {
  describe('generic callback references', () => {
    test('test(name, body<T>) is still a test', () => {
      const s = sum(`function body<T>() { expect(1).toBe(1); }\ntest('x', body<number>);`);
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });

    test('an instantiation expression does not change what a name resolves to', () => {
      const s = sum(
        `const check = <T,>() => expect(1).toBe(1);\ntest('x', () => { check<number>(); });`,
      );
      expect(shape(s)).toEqual({ x: ['toBe:4'] });
    });
  });

  describe('node:assert is resolved through bindings', () => {
    test.each([
      [
        'a shadowed named import',
        `import { strictEqual as check } from 'node:assert';
         test('x', () => { const check = () => {}; check(1, 1); });`,
      ],
      [
        'a shadowed default import',
        `import assert from 'node:assert';
         test('x', () => { const assert = { equal() {} }; assert.equal(1, 1); });`,
      ],
      [
        'a shadowed namespace import',
        `import * as a from 'node:assert';
         test('x', () => { const a = { equal() {} }; a.equal(1, 1); });`,
      ],
      [
        'a parameter named assert',
        `test('x', () => { [{ equal() {} }].forEach((assert) => assert.equal(1, 1)); });`,
      ],
      [
        'a local object that only looks like assert',
        `const assert = { equal() {} };\ntest('x', () => { assert.equal(1, 1); });`,
      ],
    ])('%s is not an assertion', (_label, source) => {
      expect(shape(sum(source)).x).toEqual([]);
    });

    test('real imports are still assertions, whatever they are called', () => {
      const s = sum(`import { strictEqual as same } from 'node:assert';
        import eq from 'node:assert/strict';
        test('x', () => { same(1, 1); eq.equal(2, 2); });`);
      expect(shape(s).x).toEqual(['assert.strictEqual:4', 'assert.strictEqual:4']);
    });
  });

  describe('CommonJS assert keeps its strictness', () => {
    test.each([
      [
        `const assert = require('node:assert/strict');`,
        'assert.equal(1, 1);',
        'assert.strictEqual:4',
      ],
      [`const assert = require('assert/strict');`, 'assert.equal(1, 1);', 'assert.strictEqual:4'],
      [
        `const assert = require('node:assert').strict;`,
        'assert.equal(1, 1);',
        'assert.strictEqual:4',
      ],
      [
        `const { strict: assert } = require('node:assert');`,
        'assert.equal(1, 1);',
        'assert.strictEqual:4',
      ],
      [`const { equal } = require('node:assert/strict');`, 'equal(1, 1);', 'assert.strictEqual:4'],
      [
        `const { deepEqual: same } = require('node:assert/strict');`,
        'same(1, 1);',
        'assert.deepStrictEqual:4',
      ],
      // loose stays loose
      [`const assert = require('node:assert');`, 'assert.equal(1, 1);', 'assert.equal:3'],
      [`const { equal } = require('node:assert');`, 'equal(1, 1);', 'assert.equal:3'],
      [
        `const assert = require('node:assert');`,
        'assert.strict.equal(1, 1);',
        'assert.strictEqual:4',
      ],
    ])('%s %s', (decl, call, expected) => {
      expect(shape(sum(`${decl}\ntest('x', () => { ${call} });`)).x).toEqual([expected]);
    });

    test('switching a require from strict to loose is visible', () => {
      const strict = shape(
        sum(
          `const assert = require('node:assert/strict');\ntest('x', () => { assert.equal(1, 1); });`,
        ),
      ).x;
      const loose = shape(
        sum(`const assert = require('node:assert');\ntest('x', () => { assert.equal(1, 1); });`),
      ).x;
      expect(strict).not.toEqual(loose);
    });
  });

  describe('the node:test context can be called anything', () => {
    test.each(['t', 'ctx', 'context', 'tc'])('%s.assert', (name) => {
      const s = sum(
        `import { test } from 'node:test';\ntest('x', (${name}) => { ${name}.assert.strictEqual(1, 1); ${name}.assert.equal(2, 2); });`,
      );
      expect(shape(s).x).toEqual(['assert.strictEqual:4', 'assert.equal:3']);
    });

    test('an unrelated object called t is not the context', () => {
      const s = sum(`import { test } from 'node:test';
        test('x', (ctx) => { const t = { assert: { equal() {} } }; t.assert.equal(1, 1); });`);
      expect(shape(s).x).toEqual([]);
    });

    test('only node:test callbacks have a context', () => {
      const s = sum(
        `import { test } from 'vitest';\ntest('x', (ctx) => { ctx.assert.equal(1, 1); });`,
      );
      expect(shape(s).x).toEqual([]);
    });

    test('the context is not the strict module', () => {
      const s = sum(`import { test } from 'node:test';\nimport assert from 'node:assert/strict';
        test('x', (ctx) => { ctx.assert.equal(1, 1); assert.equal(1, 1); });`);
      expect(shape(s).x).toEqual(['assert.equal:3', 'assert.strictEqual:4']);
    });
  });

  describe('replacing a value replaces what it was', () => {
    test('a function assigned over a mock is not a mock', () => {
      const s = sum(`test('x', () => { let fn = vi.fn(); fn = () => 1; expect(fn()).toBe(1); });`);
      expect(shape(s).x).toEqual(['toBe:4']);
    });

    test('a non-function assigned over a helper removes its assertions', () => {
      const s = sum(`const noop = () => {};
        test('x', () => { let check = () => expect(1).toBe(1); check = noop; check(); });`);
      expect(shape(s).x).toEqual([]);
    });

    test('assigning another helper makes this one that helper', () => {
      const s = sum(`const real = () => expect(2).toEqual(2);
        test('x', () => { let check = () => {}; check = real; check(); });`);
      expect(shape(s).x).toEqual(['toEqual:4']);
    });

    test('reassigned object methods are replaced too', () => {
      const s = sum(`const page = { ok() { expect(1).toBe(1); } };
        test('x', () => { let p = page; p = {}; p.ok(); });`);
      expect(shape(s).x).toEqual([]);
    });

    test('an alias keeps the methods of what it points at', () => {
      const s = sum(`const page = { ok() { expect(1).toBe(1); } };
        test('x', () => { const p = page; p.ok(); });`);
      expect(shape(s).x).toEqual(['toBe:4']);
    });
  });

  describe('mock state is read where it is used', () => {
    test('an earlier use keeps the state it had', () => {
      const s = sum(`test('x', () => {
        let fn = vi.fn();
        expect(fn).toBeDefined();
        fn = realFn;
        expect(fn).toBeDefined();
      });`);
      expect(shape(s).x).toEqual(['toBeDefined:1@mock', 'toBeDefined:1']);
    });

    test('a value derived from a mock stays derived from it', () => {
      const s = sum(`test('x', () => {
        let m = vi.fn();
        const out = m();
        m = realFn;
        expect(out).toBe(1);
        expect(m).toBeDefined();
      });`);
      expect(shape(s).x).toEqual(['toBe:4@mock', 'toBeDefined:1']);
    });

    test('an assignment inside a function that never runs changes nothing outside it', () => {
      const s = sum(`let fn = vi.fn();
        function reset() { fn = realFn; }
        test('x', () => { expect(fn).toBeDefined(); });`);
      expect(shape(s).x).toEqual(['toBeDefined:1@mock']);
    });

    test('a variable local to such a function can still change', () => {
      const s = sum(`function helper() { let a = vi.fn(); a = realFn; expect(a).toBeDefined(); }
        test('x', () => { helper(); });`);
      expect(shape(s).x).toEqual(['toBeDefined:1']);
    });

    test('an assignment in the test body takes effect', () => {
      const s = sum(`let fn = vi.fn();
        test('x', () => { fn = realFn; expect(fn).toBeDefined(); });`);
      expect(shape(s).x).toEqual(['toBeDefined:1']);
    });
  });

  describe('tests declared inside functions exist where the function is called', () => {
    test('an uncalled function registers nothing', () => {
      const s = sum(`function unused() { test('x', () => { expect(1).toBe(1); }); }`);
      expect(s.tests).toEqual([]);
    });

    test('wrapping every test in a function that is never called leaves no tests', () => {
      const before = sum(
        `test('a', () => { expect(1).toBe(1); });\ntest('b', () => { expect(2).toBe(2); });`,
      );
      const after = sum(
        `function all() { test('a', () => { expect(1).toBe(1); }); test('b', () => { expect(2).toBe(2); }); }`,
      );
      expect(before.tests).toHaveLength(2);
      expect(after.tests).toEqual([]);
    });

    test('a call at the top of the file registers them', () => {
      const s = sum(`function suite() { test('works', () => { expect(1).toBe(1); }); }\nsuite();`);
      expect(shape(s)).toEqual({ works: ['toBe:4'] });
    });

    test('a function declared after its call still registers them', () => {
      const s = sum(`suite();\nfunction suite() { test('works', () => { expect(1).toBe(1); }); }`);
      expect(shape(s)).toEqual({ works: ['toBe:4'] });
    });

    test('a shared suite called from two describes exists in both', () => {
      const s = sum(`function shared() { test('works', () => { expect(1).toBe(1); }); }
        describe('A', () => { shared(); });
        describe('B', () => { shared(); });`);
      expect(s.tests.map((t) => t.id)).toEqual(['A > works', 'B > works']);
    });

    test('called twice in one place, the second gets a suffix', () => {
      const s = sum(`function shared() { test('works', () => {}); }\nshared();\nshared();`);
      expect(s.tests.map((t) => t.id)).toEqual(['works', 'works #2']);
    });

    test('a describe inside the function is relative to the caller', () => {
      const s = sum(`function suite() { describe('inner', () => { test('t', () => {}); }); }
        describe('outer', () => { suite(); });`);
      expect(s.tests.map((t) => t.id)).toEqual(['outer > inner > t']);
    });

    test('describe(name, namedFunction) puts its tests under that name', () => {
      const s = sum(`function register() { test('a', () => { expect(1).toBe(1); }); }
        describe('s', register);`);
      expect(shape(s)).toEqual({ 's > a': ['toBe:4'] });
    });

    test('a describe modifier reaches the tests a named function registers', () => {
      const s = sum(`function register() { test('a', () => {}); }\ndescribe.skip('s', register);`);
      expect(s.tests.map((t) => [t.id, t.modifier])).toEqual([['s > a', 'skip']]);
    });

    test('the order of ids follows the order of the calls', () => {
      const s = sum(`function shared() { test('shared', () => {}); }
        test('before', () => {});
        shared();
        test('after', () => {});`);
      expect(s.tests.map((t) => t.id)).toEqual(['before', 'shared', 'after']);
    });

    test('an anonymous function that runs on the spot still registers', () => {
      const s = sum(`(() => { test('x', () => {}); })();`);
      expect(s.tests.map((t) => t.id)).toEqual(['x']);
    });

    test('tests registered by a function are checked like any other', () => {
      const s = sum(
        `function shared() { test.skip('works', () => { expect(1).toBe(1); }); }\nshared();`,
      );
      expect(s.tests[0]).toMatchObject({ id: 'works', modifier: 'skip' });
    });
  });
});

describe('fourth review', () => {
  describe('vi.doMock only counts when it runs', () => {
    test('a doMock inside a function that never runs mocks nothing', () => {
      const s = sum(`import { api } from './api';
        function unused() { vi.doMock('./api'); }
        test('x', () => { expect(api()).toBe(1); });`);
      expect(shape(s).x).toEqual(['toBe:4']);
    });

    test('a doMock at the top, or inside a test, does', () => {
      const top = sum(
        `import { api } from './api';\nvi.doMock('./api');\ntest('x', () => { expect(api()).toBe(1); });`,
      );
      const inTest = sum(
        `import { api } from './api';\ntest('x', () => { vi.doMock('./api'); expect(api()).toBe(1); });`,
      );
      expect(shape(top).x).toEqual(['toBe:4@mock']);
      expect(shape(inTest).x).toEqual(['toBe:4@mock']);
    });

    test('vi.mock is hoisted by the framework, wherever it is written', () => {
      const s = sum(
        `import { api } from './api';\nfunction setup() { vi.mock('./api'); }\ntest('x', () => { expect(api()).toBe(1); });`,
      );
      expect(shape(s).x).toEqual(['toBe:4@mock']);
    });
  });

  describe('tests registered through a callback API', () => {
    test('[a, b].forEach(register) registers what register declares', () => {
      // the elements of the array are not known, so it is registered once, named by its expression
      const s = sum(`function register(name) { test(name, () => { expect(1).toBe(1); }); }
        ['a', 'b'].forEach(register);`);
      expect(shape(s)).toEqual({ name: ['toBe:4'] });
    });

    test('extracting an inline registration callback keeps its tests', () => {
      const inline = sum(`[1].forEach(() => { test('works', () => { expect(1).toBe(1); }); });`);
      const named = sum(
        `function register() { test('works', () => { expect(1).toBe(1); }); }\n[1].forEach(register);`,
      );
      expect(shape(named)).toEqual(shape(inline));
    });

    test('inside a describe, under its name', () => {
      const s = sum(`function register() { test('works', () => { expect(1).toBe(1); }); }
        describe('s', () => { [1].forEach(register); });`);
      expect(s.tests.map((t) => t.id)).toEqual(['s > works']);
    });

    test('an arrow function does not count as a call', () => {
      const s = sum(`function register() { test('works', () => {}); }\n[1].forEach(() => {});`);
      expect(s.tests).toEqual([]);
    });
  });

  describe('hoisting and var', () => {
    test('a function declared below the test is already in scope above it', () => {
      const s = sum(
        `test('x', () => { expect(1).toBe(1); });\nfunction expect() { return { toBe() {} }; }`,
      );
      expect(shape(s).x).toEqual([]);
    });

    test('a hoisted helper is found by a test written before it', () => {
      const s = sum(`test('x', () => { check(); });\nfunction check() { expect(1).toBe(1); }`);
      expect(shape(s).x).toEqual(['toBe:4']);
    });

    test('a hoisted function inside a block', () => {
      const s = sum(
        `describe('s', () => {\n  test('x', () => { expect(1).toBe(1); });\n  function expect() { return { toBe() {} }; }\n});`,
      );
      expect(shape(s)['s > x']).toEqual([]);
    });

    test('var is visible outside the block that declares it', () => {
      const s = sum(`test('x', () => { { var check = () => expect(1).toBe(1); } check(); });`);
      expect(shape(s).x).toEqual(['toBe:4']);
    });

    test('let and const stay in their block', () => {
      const s = sum(`test('x', () => { { const check = () => expect(1).toBe(1); } check(); });`);
      expect(shape(s).x).toEqual([]);
    });

    test('a var mock is a mock outside its block too', () => {
      const s = sum(`test('x', () => { { var fn = vi.fn(); } expect(fn).toBeDefined(); });`);
      expect(shape(s).x).toEqual(['toBeDefined:1@mock']);
    });
  });

  describe('what a helper was when it was called', () => {
    test('reassigning it afterwards does not erase the earlier call', () => {
      const s = sum(
        `test('x', () => { let check = () => expect(1).toBe(1); check(); check = () => {}; });`,
      );
      expect(shape(s).x).toEqual(['toBe:4']);
    });

    test('nor credit an assertion that was never in the function that ran', () => {
      const s = sum(
        `test('x', () => { let check = () => {}; check(); check = () => expect(1).toBe(1); });`,
      );
      expect(shape(s).x).toEqual([]);
    });

    test('a suite registered by a name that is reassigned later keeps its tests', () => {
      const s = sum(
        `let register = () => { test('works', () => {}); };\nregister();\nregister = () => {};`,
      );
      expect(s.tests.map((t) => t.id)).toEqual(['works']);
    });

    test('a named callback that is reassigned later keeps its body', () => {
      const s = sum(`let body = () => { expect(1).toBe(1); };\ntest('x', body);\nbody = () => {};`);
      expect(shape(s).x).toEqual(['toBe:4']);
    });
  });

  describe('a test that is skipped changes nothing outside itself', () => {
    test('assignments in it do not reach the tests that run', () => {
      const s = sum(`let fn = vi.fn();
        test.skip('a', () => { fn = realFn; });
        test('b', () => { expect(fn).toBeDefined(); });`);
      expect(shape(s).b).toEqual(['toBeDefined:1@mock']);
    });

    test('also when the describe around it is skipped', () => {
      const s = sum(`let fn = vi.fn();
        describe.skip('s', () => { test('a', () => { fn = realFn; }); });
        test('b', () => { expect(fn).toBeDefined(); });`);
      expect(shape(s).b).toEqual(['toBeDefined:1@mock']);
    });

    test('a test that runs does change it, and its own variables always can', () => {
      const s = sum(`let fn = vi.fn();
        test('a', () => { fn = realFn; });
        test('b', () => { expect(fn).toBeDefined(); });
        test.skip('c', () => { let own = vi.fn(); own = realFn; expect(own).toBeDefined(); });`);
      expect(shape(s).b).toEqual(['toBeDefined:1']);
      expect(shape(s).c).toEqual(['toBeDefined:1']);
    });
  });

  describe('callbacks that are only stored', () => {
    test.each([
      ['vi.fn(() => expect(1).toBe(1))'],
      ['jest.fn(() => expect(1).toBe(1))'],
      ['vi.spyOn(obj, "m").mockImplementation(() => expect(1).toBe(1))'],
      ['fn.mockImplementationOnce(() => { expect(1).toBe(1); })'],
      ['vi.mock("./x", () => { expect(1).toBe(1); return {}; })'],
    ])('%s does not count', (call) => {
      expect(shape(sum(`test('x', () => { ${call}; });`)).x).toEqual([]);
    });

    test('callbacks that do run still count', () => {
      const s = sum(`test('x', async () => {
        [1].forEach(() => expect(1).toBe(1));
        await retry(() => expect(2).toEqual(2));
        (() => expect(3).toBe(3))();
        await Promise.all([1].map(async () => expect(4).toBe(4)));
        await test.step('s', async () => { expect(5).toBe(5); });
      });`);
      expect(shape(s).x).toEqual(['toBe:4', 'toEqual:4', 'toBe:4', 'toBe:4', 'toBe:4']);
    });

    test('a named function given to a mock is not run either', () => {
      const s = sum(`test('x', () => { const check = () => expect(1).toBe(1); vi.fn(check); });`);
      expect(shape(s).x).toEqual([]);
    });
  });

  describe('timeouts set while tests are being registered', () => {
    test('a helper called at the top sets the file timeout', () => {
      const s = sum(
        `function configure() { jest.setTimeout(15000); }\nconfigure();\ntest('x', () => {});`,
      );
      expect(s.tests[0]!.timeoutMs).toBe(15000);
    });

    test('a helper called inside a describe sets that suite timeout', () => {
      const s = sum(`function configure() { test.setTimeout(9000); }
        describe('s', () => { configure(); test('x', () => {}); });
        test('outside', () => {});`);
      expect(s.tests.map((t) => [t.id, t.timeoutMs])).toEqual([
        ['s > x', 9000],
        ['outside', undefined],
      ]);
    });

    test('a helper that is never called sets nothing', () => {
      const s = sum(`function configure() { jest.setTimeout(15000); }\ntest('x', () => {});`);
      expect(s.tests[0]!.timeoutMs).toBeUndefined();
    });
  });

  describe('the node:test context in a named callback', () => {
    test('whatever the parameter is called, wherever the function is declared', () => {
      const before = sum(
        `import { test } from 'node:test';\nfunction body(ctx) { ctx.assert.strictEqual(1, 1); }\ntest('x', body);`,
      );
      const after = sum(
        `import { test } from 'node:test';\ntest('x', body);\nfunction body(context) { context.assert.equal(1, 1); }`,
      );
      expect(shape(before).x).toEqual(['assert.strictEqual:4']);
      expect(shape(after).x).toEqual(['assert.equal:3']);
    });

    test('a helper that takes the context works too', () => {
      const s = sum(`import { test } from 'node:test';
        function check(t) { t.assert.equal(1, 1); }
        test('x', (ctx) => { check(ctx); });`);
      expect(shape(s).x).toEqual(['assert.equal:3']);
    });

    test('in other files a parameter named assert-something is not the context', () => {
      const s = sum(
        `import { test } from 'vitest';\nfunction check(t) { t.assert.equal(1, 1); }\ntest('x', () => { check(1); });`,
      );
      expect(shape(s).x).toEqual([]);
    });
  });
});
