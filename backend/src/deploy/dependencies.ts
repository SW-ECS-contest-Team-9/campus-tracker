// A pull can bring a package.json / package-lock.json change, and the server cannot install packages by itself.
// Compare the lockfile with what npm recorded in node_modules (node_modules/.package-lock.json, written by every
// npm install / npm ci) and say so in one line. Node built-ins only: this runs before the server modules are loaded.
import fs from 'node:fs';
import path from 'node:path';

type Packages = Record<string, { version?: string; optional?: boolean; link?: boolean }>;

/** Packages the lockfile wants that are not installed in that version. Optional ones (other platforms) are not counted. */
export function lockDrift(wanted: Packages, installed: Packages): string[] {
  return Object.entries(wanted)
    .filter(([name, p]) => name.includes('node_modules/') && !p.optional && !p.link && installed[name]?.version !== p.version)
    .map(([name, p]) => `${name.replace(/^.*node_modules\//, '')}@${p.version}`);
}

/** null = in step (or nothing to compare with); otherwise the one-line instruction. */
export function dependencyDrift(repoRoot = path.resolve(import.meta.dirname, '../../..')): string | null {
  try {
    const read = (f: string): Packages => JSON.parse(fs.readFileSync(path.join(repoRoot, f), 'utf8')).packages ?? {};
    if (!fs.existsSync(path.join(repoRoot, 'package-lock.json'))) return null;
    if (!fs.existsSync(path.join(repoRoot, 'node_modules/.package-lock.json'))) return 'node_modules 가 없음: 저장소 폴더에서 `npm ci` 를 돌린 뒤 서버를 다시 켠다';
    const drift = lockDrift(read('package-lock.json'), read('node_modules/.package-lock.json'));
    return drift.length ? `package-lock.json 과 node_modules 가 다름(${drift.length}개: ${drift.slice(0, 5).join(', ')}${drift.length > 5 ? ' …' : ''}): 저장소 폴더에서 \`npm ci\` 를 돌린 뒤 서버를 다시 켠다` : null;
  } catch (err) {
    return `의존성 비교 실패(${err instanceof Error ? err.message : String(err)}): \`npm ci\` 를 돌려 본다`;
  }
}
