/**
 * Raw GPS quality decisions (qc-v1) for stored sessions -> raw_location_qc. Read-only on raw data.
 *
 *   npm run qc:run -- --all
 *   npm run qc:run -- --session=<uuid|prefix>
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { qcService } from '../src/modules/qc/qc.service.js';

const { values: args } = parseArgs({ options: { all: { type: 'boolean', default: false }, session: { type: 'string', multiple: true } } });

async function main() {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM collection_sessions ORDER BY started_at');
  const ids = args.all ? rows.map((r) => r.id) : (args.session ?? []).flatMap((p) => rows.filter((r) => r.id.startsWith(p)).map((r) => r.id));
  if (!ids.length) throw new Error('Pass --all or --session=<uuid|prefix>');
  const table: Record<string, unknown>[] = [];
  for (const id of ids) {
    const s = await qcService.run(id);
    table.push({ session: id.slice(0, 8), fixes: s.total, accepted: s.byStatus.ACCEPTED ?? 0, suspect: s.byStatus.SUSPECT ?? 0, rejected: s.byStatus.REJECTED ?? 0,
      reasons: Object.entries(s.byReason).map(([k, v]) => `${k} ${v}`).join(', ') });
  }
  console.table(table);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
