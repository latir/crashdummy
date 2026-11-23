const EXTS = 'js,jsx,ts,tsx,mjs,cjs,cts,mts';

/**
 * Default test file globs from the plan, restricted to JS/TS extensions so snapshot files and
 * other assets under `__tests__/` or `e2e/` are not parsed as tests.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  `**/*.{test,spec}.{${EXTS}}`,
  `**/__tests__/**/*.{${EXTS}}`,
  `e2e/**/*.{${EXTS}}`,
];

/** Translate a glob (`**`, `*`, `?`, `{a,b}`) into a RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) {
      re += '|';
    } else if (c === '\\' && i + 1 < glob.length) {
      re += escapeRe(glob[++i]!);
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/** Build a predicate for repo-relative posix paths. */
export function createTestFileMatcher(
  globs: readonly string[] = DEFAULT_TEST_GLOBS,
): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (path) => {
    const p = path.startsWith('./') ? path.slice(2) : path;
    return patterns.some((re) => re.test(p));
  };
}

export function isTestFile(path: string, globs?: readonly string[]): boolean {
  return createTestFileMatcher(globs)(path);
}
