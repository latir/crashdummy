import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  EXIT,
  REPORT_FORMATS,
  SourceError,
  explainMatchers,
  explainRule,
  explainableRules,
  exitCodeOf,
  filesSource,
  formatReport,
  gitSource,
  loadConfig,
  readFileListFromStream,
  score,
  type ChangedFile,
  type ReportFormat,
} from '@crashdummy/core';

/** Everything the CLI touches outside itself, so tests can run it without a process. */
export interface Io {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** File list for `--stdin`. */
  stdin?: AsyncIterable<Buffer | string>;
  /** Colour the pretty format. */
  color: boolean;
}

const HELP = `crashdummy: scores the tests you changed and fails changes that weaken a suite.

Usage
  crashdummy [check] [options]     check changed tests (default)
  crashdummy explain <rule>        what a rule catches and how to fix it
  crashdummy explain matchers      matchers the strength lattice does not know

Options
  --format <pretty|agent|json>     output format (default pretty)
  --files <paths...>               check these files instead of a git diff
  --stdin                          read the file list from stdin
  --base <ref>                     git base (default: merge-base with origin/HEAD)
  --source <git|files>             force a change source
  --strict-warn                    exit 2 when the verdict is warn
  --help, --version

Exit codes: 0 pass, 1 fail, 2 warn (with --strict-warn), 3 tool error.
`;

function version(): string {
  const url = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

class UsageError extends Error {
  override name = 'UsageError';
}

/** Run the CLI. Resolves to the exit code. Never throws: failures are exit code 3. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof SourceError
    ) {
      io.stderr(`crashdummy: ${error.message}\n`);
    } else {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      io.stderr(`crashdummy: unexpected error\n${message}\n`);
    }
    return EXIT.error;
  }
}

async function dispatch(argv: readonly string[], io: Io): Promise<number> {
  const command = argv[0] === 'check' || argv[0] === 'explain' ? argv[0] : 'check';
  const rest = argv[0] === command ? argv.slice(1) : argv;

  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: {
        format: { type: 'string' },
        files: { type: 'string', multiple: true },
        stdin: { type: 'boolean' },
        base: { type: 'string' },
        source: { type: 'string' },
        'strict-warn': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}. See --help.`);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(HELP);
    return EXIT.pass;
  }
  if (values.version) {
    io.stdout(`${version()}\n`);
    return EXIT.pass;
  }

  const format = (values.format ?? 'pretty') as ReportFormat;
  if (!REPORT_FORMATS.includes(format)) {
    const later = values.format === 'sarif' || values.format === 'md';
    throw new UsageError(
      later
        ? `--format ${values.format} is not available yet (available: ${REPORT_FORMATS.join(', ')})`
        : `unknown format "${values.format}" (available: ${REPORT_FORMATS.join(', ')})`,
    );
  }

  if (command === 'explain' && positionals[0] !== 'matchers') {
    return explain(positionals[0], io);
  }

  const config = loadConfig(io.cwd);
  const changes = await collect(values, positionals, config.testGlobs, io);
  const report = await score(changes, { cwd: io.cwd, ...config });

  if (command === 'explain') {
    io.stdout(`${explainMatchers(report.unknownMatchers ?? [])}\n`);
    return EXIT.pass;
  }
  io.stdout(`${formatReport(report, format, { color: io.color })}\n`);
  return exitCodeOf(report.verdict, values['strict-warn'] === true);
}

function explain(id: string | undefined, io: Io): number {
  if (!id) {
    throw new UsageError(
      `explain needs a rule, for example: crashdummy explain oracle/no-assertion`,
    );
  }
  const text = explainRule(id);
  if (!text) {
    throw new UsageError(`unknown rule "${id}". Rules: ${explainableRules().join(', ')}`);
  }
  io.stdout(`${text}\n`);
  return EXIT.pass;
}

async function collect(
  values: { files?: string[]; stdin?: boolean; base?: string; source?: string },
  positionals: readonly string[],
  testGlobs: readonly string[] | undefined,
  io: Io,
): Promise<ChangedFile[]> {
  const common = { cwd: io.cwd, ...(testGlobs ? { testGlobs } : {}) };
  let files = [...(values.files ?? []), ...(values.files ? positionals : [])];
  if (values.stdin) {
    if (!io.stdin) throw new UsageError('--stdin needs a file list on standard input');
    files = [...files, ...(await readFileListFromStream(io.stdin))];
  }

  const source = values.source ?? (files.length > 0 || values.stdin ? 'files' : 'git');
  if (source === 'files') {
    // an empty list from --stdin is a normal run with nothing to check (a filter found no
    // changed tests); only a forced `--source files` with no list at all is a mistake
    if (files.length === 0 && !values.stdin) {
      throw new UsageError('--source files needs --files or --stdin');
    }
    return filesSource.collect({ ...common, files });
  }
  if (source === 'git') {
    if (!(await gitSource.detect(io.cwd))) {
      throw new UsageError('not a git repository. Pass --files, or run it inside a repository.');
    }
    return gitSource.collect({ ...common, ...(values.base ? { base: values.base } : {}) });
  }
  throw new UsageError(`--source ${source} is not available yet (available: git, files)`);
}
