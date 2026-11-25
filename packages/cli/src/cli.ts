import { run } from './main.js';

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: process.stdin,
  color: process.stdout.isTTY === true && !process.env['NO_COLOR'],
});
// set, not process.exit(): lets stdout flush when it is a pipe
process.exitCode = code;
