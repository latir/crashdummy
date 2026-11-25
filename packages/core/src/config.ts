import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './errors.js';
import { parseMatcherOverrides, type MatcherOverrides } from './rules/lattice.js';

/** What the user can set. Plain JSON, never a script, so startup never loads a TS loader. */
export interface Config {
  testGlobs?: string[];
  /** `"off"` turns a rule off. `{ "penalty": n }` changes what each finding removes. */
  rules?: Record<string, 'off' | { penalty: number }>;
  minScore?: number;
  maxDrop?: number;
  matchers?: MatcherOverrides;
  assertFunctionNames?: string[];
  /** What an unparseable test file does. Default: `warn` for hooks, `fail` otherwise. */
  onParseError?: 'warn' | 'fail';
}

const KEYS = new Set([
  'testGlobs',
  'rules',
  'minScore',
  'maxDrop',
  'matchers',
  'assertFunctionNames',
  'onParseError',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringList = (key: string, v: unknown): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
    throw new ConfigError(`"${key}" must be a list of non-empty strings`);
  }
  return v as string[];
};

const score = (key: string, v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
    throw new ConfigError(`"${key}" must be an integer from 0 to 100`);
  }
  return v;
};

/** Validate a parsed config. Throws `ConfigError`, naming the key, on anything unexpected. */
export function parseConfig(input: unknown): Config {
  if (!isRecord(input)) throw new ConfigError('the config must be a JSON object');
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) {
      throw new ConfigError(`unknown config key "${key}" (known: ${[...KEYS].join(', ')})`);
    }
  }
  const out: Config = {};
  if (input['testGlobs'] !== undefined) out.testGlobs = stringList('testGlobs', input['testGlobs']);
  if (input['assertFunctionNames'] !== undefined) {
    out.assertFunctionNames = stringList('assertFunctionNames', input['assertFunctionNames']);
  }
  if (input['minScore'] !== undefined) out.minScore = score('minScore', input['minScore']);
  if (input['maxDrop'] !== undefined) out.maxDrop = score('maxDrop', input['maxDrop']);
  if (input['onParseError'] !== undefined) {
    const v = input['onParseError'];
    if (v !== 'warn' && v !== 'fail')
      throw new ConfigError('"onParseError" must be "warn" or "fail"');
    out.onParseError = v;
  }
  if (input['matchers'] !== undefined) out.matchers = parseMatcherOverrides(input['matchers']);
  if (input['rules'] !== undefined) {
    const rules = input['rules'];
    if (!isRecord(rules)) throw new ConfigError('"rules" must be an object');
    const parsed: NonNullable<Config['rules']> = {};
    for (const [id, value] of Object.entries(rules)) {
      if (value === 'off') parsed[id] = 'off';
      else if (
        isRecord(value) &&
        Object.keys(value).every((k) => k === 'penalty') &&
        typeof value['penalty'] === 'number' &&
        value['penalty'] >= 0
      ) {
        parsed[id] = { penalty: value['penalty'] };
      } else {
        throw new ConfigError(`"rules.${id}" must be "off" or { "penalty": <number> }`);
      }
    }
    out.rules = parsed;
  }
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `.crashdummy/config.json`, else the `"crashdummy"` key of `package.json`, else the defaults.
 * An invalid config is an error, not silently ignored: a typo would otherwise change the verdict.
 */
export function loadConfig(cwd: string): Config {
  const file = join(cwd, '.crashdummy', 'config.json');
  if (existsSync(file)) return parseConfig(readJson(file));
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    const json = readJson(pkg);
    if (isRecord(json) && json['crashdummy'] !== undefined) return parseConfig(json['crashdummy']);
  }
  return {};
}
