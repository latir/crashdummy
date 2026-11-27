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
 * `git diff-tree -z --name-status -M` output, NUL separated: `A\0path\0`, `M\0path\0`,
 * `R087\0old\0new\0`, `D\0path\0`. Without `-z` git quotes paths with non-ASCII characters, tabs
 * or quotes, so `src/日本語.test.ts` would look like it ends in a quote.
 * A rename with no change (R100) is not a new test, so callers drop it.
 */
export function parseNameStatus(output) {
  const out = [];
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const status = code[0];
    if (status === 'R' || status === 'C') {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      i += 2;
      if (!oldPath || !path) break;
      out.push({ status, similarity: Number(code.slice(1) || 0), oldPath, path });
    } else {
      const path = fields[i + 1];
      i += 1;
      if (!path) break;
      out.push({ status, similarity: 100, path });
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

// The project's own licence: LICENSE, LICENSE.md, COPYING, and the dual-licence forms
// LICENSE-MIT / LICENSE-APACHE. Not LICENSE-3rdparty.txt or LICENSE.vendor: those cover code the
// project bundles, so they say nothing about the project's own tests.
const LICENSE_FILE =
  /^(?:(?:licen[cs]e|copying|unlicense)(?:\.(?:md|markdown|txt|rst))?|licen[cs]e[-_.](?:mit|apache(?:-2\.0)?|bsd(?:-[23]-clause)?|isc)(?:\.(?:md|markdown|txt))?)$/i;

/** Which root-level file holds the project's own licence, or null. */
export function findLicenseFile(names) {
  const hits = names.filter((n) => LICENSE_FILE.test(n));
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return hits[0] ?? null;
}

/**
 * Permissive licences only, by their standard wording. Anything else (GPL, MPL, a custom text,
 * a licence with extra conditions) is null, and the file is not used.
 */
export function classifyLicense(text) {
  const t = text.replace(/\s+/g, ' ').toLowerCase();
  // Whatever the grant says, a restriction anywhere in the text means it is no longer the
  // standard licence. This comes first: the Functional Source License and similar name Apache 2.0
  // as the licence the code turns into later, which is not the licence it has now.
  if (RESTRICTION.test(t) || DEFERRED_GRANT.test(t)) return null;
  if (t.includes('apache license') && t.includes('version 2.0')) return 'Apache-2.0';
  // MIT, ISC and BSD are short, and people append their own conditions or carve-outs to them
  if (CARVE_OUT.test(t)) return null;
  if (t.includes('permission is hereby granted, free of charge')) return 'MIT';
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

const RESTRICTION =
  /non-?commercial|not for commercial|no commercial use|commercial use (is )?(prohibited|not (allowed|permitted))|(may|can) not be (used|sold|redistributed) (commercially|for)|only be used for|for (personal|educational|research) (use )?only|additional condition/;

/** Source-available licences: free to read, with limits, or free only after a delay. */
const DEFERRED_GRANT =
  /functional source license|business source license|fair source|elastic license|sustainable use license|server side public license|polyform|commons clause|source[- ]available|competing use|change date|change license|future license/;

/** A permissive licence that leaves parts of the repository under something else. */
const CARVE_OUT =
  /(except|excluding|excluded|other than|not covered by|separate licen[cs]e|different licen[cs]e)\b[^.]{0,200}(\/ee\b|\bee\/|enterprise|commercial|proprietary)/;

/**
 * Directories repositories use for code under a different, usually commercial, licence. A path
 * inside one is not covered by the licence at the top of the repository.
 */
const RESTRICTED_DIRS = /(^|\/)(ee|enterprise|commercial|proprietary|premium)(\/|$)/i;

export function isRestrictedPath(path) {
  return RESTRICTED_DIRS.test(path);
}

/**
 * Whether two licence texts are the same licence: equal once whitespace and case are ignored
 * and the copyright lines (the only part that names the holder) are left out. A package that
 * carries a different permissive licence than the repository root is not the same grant, and
 * NOTICE.md records only the root's.
 */
export function sameLicenseText(a, b) {
  const squash = (text) =>
    text
      .split('\n')
      .filter((l) => !/^\s*(copyright\b|©|\(c\)\s*(\d{4}|copyright\b))/i.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  return squash(a) === squash(b);
}

export const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause']);

/**
 * The copyright notice of a licence text, which NOTICE.md has to carry. A line counts when it
 * starts with "Copyright", "©" or "(c)" and goes on with a year (or, second choice, with a
 * sign: "Copyright (c) Name"). Clause text such as Apache 4(c) "(c) You must retain ..." and the
 * Apache appendix template "Copyright [yyyy] [name of copyright owner]" never count.
 */
export function copyrightLine(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/\[[^\]]*\]/.test(l)); // `[yyyy]` and other template slots
  const year = /^(?:copyright\s*(?:\(c\)|©)?|©|\(c\))\s*(?:copyright\s*)?(?:\(c\)\s*|©\s*)?\d{4}/i;
  const signed = /^(?:copyright\s*(?:\(c\)|©)|©|\(c\)\s*copyright)\s*\S/i;
  const hit = lines.find((l) => year.test(l)) ?? lines.find((l) => signed.test(l));
  return hit ? hit.slice(0, 200) : null;
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
  while (from <= end) {
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

// ---------------------------------------------------------------------------------------------
// Selection

/** A small seeded random number generator, so a selection can be repeated from its seed. */
export function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `items` in a random order that depends only on the seed. */
export function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}\b/;

/** Text that looks like it holds a credential. Such a file is never copied into the repo. */
export function looksSensitive(text) {
  return SECRET.test(text);
}

/**
 * The random sample. Files are taken in the shuffled order, so nothing about the files (and in
 * particular nothing crashdummy says about them) decides which are picked. Each framework gets at
 * most its quota, each repository at most `perRepo` files, and if a framework has too few files
 * the shortfall is filled from the others, up to `size`.
 */
export function drawRandom(files, { size, quotas, perRepo, seed }) {
  const random = seededRandom(`${seed}:random`);
  const order = shuffle(files, random);
  const taken = [];
  const perRepoCount = new Map();
  const perFramework = new Map();
  const take = (file, ignoreQuota) => {
    if (taken.length >= size) return;
    if ((perRepoCount.get(file.repo) ?? 0) >= perRepo) return;
    const used = perFramework.get(file.framework) ?? 0;
    if (!ignoreQuota && used >= (quotas[file.framework] ?? 0)) return;
    if (taken.includes(file)) return;
    taken.push(file);
    perRepoCount.set(file.repo, (perRepoCount.get(file.repo) ?? 0) + 1);
    perFramework.set(file.framework, used + 1);
  };
  for (const file of order) take(file, false);
  for (const file of order) take(file, true); // fill any shortfall
  return taken;
}

/**
 * The targeted sample: files picked because a rule fires in them, until every rule has `target`
 * findings or the pool has no more. The rarest rule is served first, and every finding in a file
 * counts for its rule, so one file can serve several. This sample measures precision only: it was
 * chosen by the tool, so it says nothing about recall.
 *
 * `findings` maps a file id to an array of rule ids (one entry per finding).
 */
export function drawTargeted(files, findings, { target, perRepo, max, taken = [] }) {
  const tally = new Map();
  const chosen = [];
  const perRepoCount = new Map();
  for (const f of taken) perRepoCount.set(f.repo, (perRepoCount.get(f.repo) ?? 0) + 1);
  const have = (id) => tally.get(id) ?? 0;
  const supply = new Map();
  for (const file of files) {
    for (const rule of new Set(findings.get(file.id) ?? [])) {
      supply.set(rule, (supply.get(rule) ?? 0) + 1);
    }
  }
  const rules = [...supply.keys()].sort(
    (a, b) => supply.get(a) - supply.get(b) || a.localeCompare(b),
  );

  for (const rule of rules) {
    const candidates = files
      .filter((f) => (findings.get(f.id) ?? []).includes(rule) && !chosen.includes(f))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const file of candidates) {
      if (have(rule) >= target || chosen.length >= max) break;
      if ((perRepoCount.get(file.repo) ?? 0) >= perRepo) continue;
      chosen.push(file);
      perRepoCount.set(file.repo, (perRepoCount.get(file.repo) ?? 0) + 1);
      for (const r of findings.get(file.id) ?? []) tally.set(r, have(r) + 1);
    }
  }
  return { chosen, tally: Object.fromEntries([...tally].sort((a, b) => a[0].localeCompare(b[0]))) };
}

/** A folder name for a case: readable, unique, and safe on every file system. */
export function caseSlug(candidate) {
  const repo = candidate.repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${repo.slice(0, 48)}-${candidate.id}`;
}
