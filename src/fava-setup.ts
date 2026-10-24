/**
 * Installs Fava for gram's Books view into .fava/venv (git-ignored).
 *   bun run fava:setup                      the pinned release from PyPI
 *   bun run fava:setup --source ../fava     a local checkout, e.g. `gh repo clone beancount/fava`
 * A checkout builds Fava's frontend with npm. gram finds the result itself, or set FINANCE_WORLD_FAVA_PYTHON.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FAVA_VERSION = '1.30.16';
const root = resolve(import.meta.dir, '..'), venv = resolve(root, '.fava/venv'), python = resolve(venv, 'bin/python');
const argv = process.argv.slice(2), at = argv.indexOf('--source'), source = at >= 0 ? argv[at + 1] : undefined;
if (at >= 0 && !source) throw new Error('--source needs the path of a Fava checkout');
const run = async (command: string[]) => {
  console.log('$ ' + command.join(' '));
  const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with ${child.exitCode}`);
};
const uv = Bun.which('uv');
if (!existsSync(python)) await (uv ? run([uv, 'venv', venv, '--python', '>=3.11']) : run(['python3', '-m', 'venv', venv]));
const target = source ? resolve(source) : `fava==${FAVA_VERSION}`;
await (uv ? run([uv, 'pip', 'install', '--python', python, target]) : run([python, '-m', 'pip', 'install', target]));
await run([python, '-I', '-c', 'import fava, cheroot; print("Fava", fava.__version__, "ready for gram")']);
