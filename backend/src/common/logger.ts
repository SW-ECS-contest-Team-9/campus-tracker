import fs from 'node:fs';
import path from 'node:path';

// Minimal structured logger: `<time> <LEVEL> <event> {json fields}`.
// Written to the console and appended to backend/logs/server.log (easy to inspect/share when the
// server runs in some other terminal). Never pass full tokens here.
type Fields = Record<string, unknown>;

const LOG_DIR = path.resolve(import.meta.dirname, '../../logs');
let file: fs.WriteStream | null = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  file = fs.createWriteStream(path.join(LOG_DIR, 'server.log'), { flags: 'a' });
} catch {
  file = null; // console only
}

function write(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields?: Fields) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${event}${fields ? ' ' + JSON.stringify(fields) : ''}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  file?.write(line + '\n');
}

export const logger = {
  info: (event: string, fields?: Fields) => write('INFO', event, fields),
  warn: (event: string, fields?: Fields) => write('WARN', event, fields),
  error: (event: string, fields?: Fields) => write('ERROR', event, fields),
};
