// Runs qc-v1 for a session and stores raw_location_qc (replaces that session's rows of the same qc version).
import { pool, withTransaction, type DbClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { spatial } from '../../geo/spatial.js';
import { sessionRepository } from '../sessions/session.repository.js';
import { fusionRepository } from '../fusion/fusion.repository.js';
import { QC_VERSION, qcLocations, type QcDecision } from './qc-v1.js';

export const qcService = {
  async run(sessionId: string): Promise<{ total: number; byStatus: Record<string, number>; byReason: Record<string, number> }> {
    const session = await sessionRepository.findView(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
    const raw = await fusionRepository.loadRawSamples(sessionId);
    const decisions = qcLocations(raw, { sessionStartedAt: session.startedAt, spatial: await spatial.context(session.spatialMapVersionId) });
    await withTransaction(async (client) => {
      await client.query('DELETE FROM raw_location_qc WHERE session_id = $1 AND qc_version = $2', [sessionId, QC_VERSION]);
      if (!decisions.length) return;
      await client.query(
        `INSERT INTO raw_location_qc (session_id, qc_version, location_sequence, "timestamp", status, reasons, details)
         SELECT $1, $2, t.seq, to_timestamp(t.ms / 1000.0), t.status, string_to_array(t.reasons, ','), t.details::jsonb
           FROM unnest($3::bigint[], $4::float8[], $5::text[], $6::text[], $7::text[]) AS t(seq, ms, status, reasons, details)`,
        [sessionId, QC_VERSION, decisions.map((d) => d.seq), decisions.map((d) => d.t), decisions.map((d) => d.status),
          decisions.map((d) => d.reasons.join(',')), decisions.map((d) => JSON.stringify(d.details))],
      );
    });
    return summarize(decisions);
  },

  async list(sessionId: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT location_sequence AS seq, (extract(epoch FROM "timestamp") * 1000)::float8 AS t, status, reasons, details
         FROM raw_location_qc WHERE session_id = $1 AND qc_version = $2 ORDER BY "timestamp", location_sequence`,
      [sessionId, QC_VERSION],
    );
    return { qcVersion: QC_VERSION, decisions: rows };
  },

  /** Decisions keyed by location sequence (computes and stores them when the session has none yet). */
  async bySequence(sessionId: string): Promise<Map<number, { status: string; reasons: string[] }>> {
    let { decisions } = await this.list(sessionId);
    if (!decisions.length) {
      await this.run(sessionId);
      decisions = (await this.list(sessionId)).decisions;
    }
    return new Map(decisions.map((d: { seq: number; status: string; reasons: string[] }) => [d.seq, { status: d.status, reasons: d.reasons }]));
  },
};

export function summarize(decisions: QcDecision[]) {
  const byStatus: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const d of decisions) {
    byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    for (const r of d.reasons) byReason[r] = (byReason[r] ?? 0) + 1;
  }
  return { total: decisions.length, byStatus, byReason };
}
