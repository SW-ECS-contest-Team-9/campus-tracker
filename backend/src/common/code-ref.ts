// Which code produced a result: git HEAD plus a hash of uncommitted changes under backend/src (null outside git).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

let cached: string | null | undefined;

export function codeRef(): string | null {
  if (cached !== undefined) return cached;
  try {
    const cwd = path.resolve(import.meta.dirname, '..', '..');
    const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const diff = execFileSync('git', ['diff', 'HEAD', '--', 'src'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    cached = diff || untracked ? `${head}+dirty.${createHash('sha256').update(diff + untracked).digest('hex').slice(0, 8)}` : head;
  } catch {
    cached = null;
  }
  return cached;
}
