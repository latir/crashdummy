// Pure helpers for the corpus harvest tool. No I/O, so they can be tested without a network.
import { createHash } from 'node:crypto';

/**
 * The agents we look for. `queries` go to GitHub's commit search (text match, loose). `pattern`
 * is what a commit message must really contain: search matches words, not trailers, so every hit
 * is verified here before it counts.
 */
export const AGENTS = [
  {
    id: 'claude',
    queries: ['"Co-Authored-By: Claude"', '"Generated with Claude Code"'],
    pattern: /^co-authored-by:\s*claude\b|generated with \[?claude code\]?/im,
  },
  {
    id: 'codex',
    queries: ['"Co-authored-by: Codex"', '"Generated with Codex"'],
    pattern: /^co-authored-by:\s*(openai\s+)?codex\b|generated (with|by) (openai )?codex/im,
  },
  {
    id: 'copilot',
    queries: ['"Co-authored-by: Copilot"'],
    pattern: /^co-authored-by:\s*copilot\b/im,
  },
  {
    id: 'cursor',
    queries: ['"Co-authored-by: Cursor Agent"'],
    pattern: /^co-authored-by:\s*cursor( agent)?\b/im,
  },
];

/** Which agent a commit message names in a trailer, or null. */
export function verifyTrailer(message) {
  for (const agent of AGENTS) if (agent.pattern.test(message)) return agent.id;
  return null;
}

const TEST_FILE = /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const TEST_DIR = /(^|\/)__tests__\/[^/]+\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const EXCLUDED =
  /(^|\/)(node_modules|vendor|vendored|third[_-]?party|dist|build|out|coverage|\.next|\.nuxt|__snapshots__|generated)\//;

/** A JS/TS test file we could use. Declaration files, snapshots and vendored code are out. */
export function isTestPath(path) {
  if (EXCLUDED.test(path)) return false;
  if (/\.d\.[cm]?ts$/.test(path)) return false;
  return TEST_FILE.test(path) || TEST_DIR.test(path);
}

/**
 * `git diff-tree --name-status -M` output: `A\tpath`, `M\tpath`, `R087\told\tnew`, `D\tpath`.
 * A rename with no change (R100) is not a new test, so callers drop it.
 */
export function parseNameStatus(output) {
  const out = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [code, a, b] = line.split('\t');
    if (!code || a === undefined) continue;
    const status = code[0];
    if (status === 'R' || status === 'C') {
      if (b === undefined) continue;
      out.push({ status, similarity: Number(code.slice(1) || 0), oldPath: a, path: b });
    } else {
      out.push({ status, similarity: 100, path: a });
    }
  }
  return out;
}

/** The files of a commit worth harvesting: added, modified, or renamed with real changes. */
export function interestingChanges(entries) {
  return entries.filter(
    (e) =>
      isTestPath(e.path) &&
      (e.status === 'A' || e.status === 'M' || (e.status === 'R' && e.similarity < 100)),
  );
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([._-][^/]*)?$/i;

/** Which root-level file holds the licence. */
export function findLicenseFile(names) {
  const hits = names.filter((n) => LICENSE_FILE.test(n));
  // LICENSE and LICENSE.md before LICENSE-3rdparty.txt and friends
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return hits[0] ?? null;
}

/**
 * Permissive licences only, by their standard wording. Anything else (GPL, MPL, a custom text,
 * a licence with extra conditions) is null, and the file is not used.
 */
export function classifyLicense(text) {
  const t = text.replace(/\s+/g, ' ').toLowerCase();
  if (t.includes('permission is hereby granted, free of charge')) {
    // some variants add conditions, such as a non-commercial clause
    return /non-?commercial|no(?:t)? .{0,40}(?:sell|commercial)/.test(t) &&
      !t.includes('without restriction')
      ? null
      : 'MIT';
  }
  if (t.includes('apache license') && t.includes('version 2.0')) return 'Apache-2.0';
  if (t.includes('permission to use, copy, modify, and/or distribute this software')) return 'ISC';
  if (t.includes('redistribution and use in source and binary forms')) {
    if (/neither the name of .{0,120} nor the names of its contributors/.test(t))
      return 'BSD-3-Clause';
    if (t.includes('endorse or promote') || t.includes('the name of the copyright holder')) {
      return 'BSD-3-Clause';
    }
    return 'BSD-2-Clause';
  }
  return null;
}

export const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause']);

/** The first copyright line, which NOTICE.md has to carry. */
export function copyrightLine(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^(copyright|\(c\)|©)/i.test(t) && /\d{4}|©|\(c\)/i.test(t)) return t.slice(0, 200);
  }
  return null;
}

/** Valid UTF-8 text of a size worth labelling. */
export function usableSource(text, { minLines = 10, maxLines = 2000 } = {}) {
  if (text.includes('\u0000') || text.includes('�')) return false;
  const lines = text.split('\n').length;
  return lines >= minLines && lines <= maxLines;
}

/** A rough framework guess for stratifying the sample. The real detection is the parser's. */
export function detectFramework(source) {
  if (/from\s+['"]vitest['"]|vi\.(fn|mock|spyOn)\(/.test(source)) return 'vitest';
  if (/from\s+['"]@playwright\/test['"]/.test(source)) return 'playwright';
  if (/from\s+['"](node:)?test['"]|require\(['"]node:test['"]\)/.test(source)) return 'node-test';
  if (/from\s+['"]@jest\/globals['"]|jest\.(fn|mock|spyOn)\(/.test(source)) return 'jest';
  if (/\b(describe|it|test)\s*\(/.test(source)) return 'unknown';
  return 'other';
}

export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** A stable short id for one harvested file. */
export function candidateId(repo, sha, path) {
  return createHash('sha256').update(`${repo}\0${sha}\0${path}`).digest('hex').slice(0, 12);
}

/** `owner/name` that is safe to use as a folder name. Anything odd is rejected. */
export function repoDirName(repo) {
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.includes('..')) {
    throw new Error(`not a repository name: ${JSON.stringify(repo)}`);
  }
  return repo.replace('/', '__');
}

/**
 * Month-long windows from `since` up to `until` (both `YYYY-MM-DD`), for commit search. One query
 * returns at most 1,000 results, so a long range has to be split.
 */
export function monthWindows(since, until) {
  const out = [];
  let from = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (from < end) {
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const to = new Date(Math.min(next.getTime() - 86400000, end.getTime()));
    out.push([from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
    from = next;
  }
  return out;
}

/** One unit of search work, so a stopped run can resume. */
export const searchKey = (query, [from, to], page) => `${query}|${from}..${to}|${page}`;

/**
 * Commits in turn from each agent, then from each repository within it, so a stage that stops at a
 * limit has seen every agent and many repositories rather than only the first in the file.
 */
export function interleave(commits) {
  const byAgent = new Map();
  for (const c of commits) {
    if (!byAgent.has(c.trailer)) byAgent.set(c.trailer, new Map());
    const repos = byAgent.get(c.trailer);
    if (!repos.has(c.repo)) repos.set(c.repo, []);
    repos.get(c.repo).push(c);
  }
  // each agent becomes a list that takes one commit per repository, round after round
  const lists = [...byAgent.values()].map((repos) => {
    const queues = [...repos.values()];
    const out = [];
    for (let i = 0; queues.some((q) => i < q.length); i++) {
      for (const q of queues) if (i < q.length) out.push(q[i]);
    }
    return out;
  });
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}
