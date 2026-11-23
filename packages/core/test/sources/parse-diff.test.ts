import { describe, expect, test } from 'vitest';
import { parseDiff } from '../../src/sources/git.js';

const SAMPLE = `:000000 100644 0000000 2fe4df4 A\tadded.test.ts
:100644 000000 286c5f5 0000000 D\tdel.test.ts
:100644 100644 9405325 91ac79b M\tkeep.test.ts
:100644 100644 04ec35a 3305618 R057\told.test.ts\tnew.test.ts
:160000 160000 1111111 2222222 M\tvendor/lib
:000000 100644 0000000 be761e0 A\t"sp\\303\\251\\"q.test.ts"

diff --git a/added.test.ts b/added.test.ts
new file mode 100644
index 0000000..2fe4df4
--- /dev/null
+++ b/added.test.ts
@@ -0,0 +1,2 @@
+n1
+n2
diff --git a/del.test.ts b/del.test.ts
deleted file mode 100644
index 286c5f5..0000000
--- a/del.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/keep.test.ts b/keep.test.ts
index 9405325..91ac79b 100644
--- a/keep.test.ts
+++ b/keep.test.ts
@@ -2 +2 @@ a
-b
+B
@@ -4,0 +5,3 @@ e
+f
+g
+h
@@ -9,2 +11,0 @@ x
-removed
-removed
diff --git a/old.test.ts b/new.test.ts
similarity index 57%
rename from old.test.ts
rename to new.test.ts
index 04ec35a..3305618 100644
--- a/old.test.ts
+++ b/new.test.ts
@@ -3 +3 @@ y
-z
+z2
diff --git a/vendor/lib b/vendor/lib
index 1111111..2222222 160000
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit 1111111
+Subproject commit 2222222
diff --git "a/sp\\303\\251\\"q.test.ts" "b/sp\\303\\251\\"q.test.ts"
new file mode 100644
index 0000000..be761e0
--- /dev/null
+++ "b/sp\\303\\251\\"q.test.ts"
@@ -0,0 +1 @@
+x
`;

describe('parseDiff', () => {
  const entries = parseDiff(SAMPLE);
  const byPath = (p: string) => entries.find((e) => e.path === p)!;

  test('reads every file in order', () => {
    expect(entries.map((e) => e.status)).toEqual(['A', 'D', 'M', 'R', 'M', 'A']);
  });

  test('added file: whole file is changed', () => {
    expect(byPath('added.test.ts').lines).toEqual([{ start: 1, end: 2 }]);
  });

  test('deleted file has no changed lines', () => {
    expect(byPath('del.test.ts').lines).toEqual([]);
  });

  test('modified file: replaced line, added block, and pure deletion ignored', () => {
    expect(byPath('keep.test.ts').lines).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 7 },
    ]);
  });

  test('rename keeps the old path and the hunks', () => {
    const r = byPath('new.test.ts');
    expect(r.oldPath).toBe('old.test.ts');
    expect(r.lines).toEqual([{ start: 3, end: 3 }]);
  });

  test('submodules are flagged', () => {
    expect(byPath('vendor/lib').gitlink).toBe(true);
    expect(byPath('keep.test.ts').gitlink).toBe(false);
  });

  test('quoted paths are decoded', () => {
    expect(entries[5]!.path).toBe('spé"q.test.ts');
    expect(entries[5]!.lines).toEqual([{ start: 1, end: 1 }]);
  });

  test('empty output', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
