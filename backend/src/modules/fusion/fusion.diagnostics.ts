// Run snapshot diagnostics (docs/MOBILITY_MAP_PLAN.md 4.2): what the algorithm decided for every raw GPS fix and
// which engine events happened, stored per run (fusion_run_fixes / fusion_run_events) for the Lab and debugging.
import type { FusionStateV4 } from './fusion-state-v4.js';
import type { FusionEventV4 } from './fusion-v4.engine.js';

export interface FixDecision {
  seq: number;
  t: number;
  forwardUsed: boolean;
  forwardReason: string | null;
  innovation: number | null;
  finalWeight: number | null;
  finalResidual: number | null;
}
export interface RunEvent { t: number; type: string; details: Record<string, unknown> }
export interface RunDiagnostics { fixes: FixDecision[]; events: RunEvent[] }

/** Events that are bulky or duplicate other tables (outputs, per-fix decisions, pedometer ticks) are not kept. */
const SKIPPED = new Set(['output', 'gps', 'gps-decision', 'gps-correction', 'gps-rejected', 'pedometer', 'pedometer-delta', 'altimeter-update', 'late-observation']);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Generic: forward GPS decisions from 'gps' / 'gps-decision' events (v2, v2.1, v4 ...), other events as they are. */
export function diagnosticsFromEvents(events: unknown[]): RunDiagnostics {
  const fixes = new Map<number, FixDecision>();
  const out: RunEvent[] = [];
  for (const value of events) {
    if (!value || typeof value !== 'object') continue;
    const e = value as Record<string, unknown>;
    const t = num(e.t);
    if (typeof e.type !== 'string' || t === null) continue;
    if ((e.type === 'gps' || e.type === 'gps-decision') && typeof e.seq === 'number' && typeof e.used === 'boolean') {
      fixes.set(e.seq, { seq: e.seq, t, forwardUsed: e.used, forwardReason: typeof e.reason === 'string' ? e.reason : null,
        innovation: num(e.innovation), finalWeight: null, finalResidual: null });
      continue;
    }
    if (SKIPPED.has(e.type)) continue;
    const { type, t: _t, ...details } = e;
    out.push({ t, type, details });
  }
  return { fixes: [...fixes.values()], events: out };
}

/** v4: forward decisions + smoother weights/residuals, steps (with stairs), kept ground contacts. */
export function diagnosticsV4(s: FusionStateV4, events: FusionEventV4[]): RunDiagnostics {
  const d = diagnosticsFromEvents(events);
  if (s.smoothed) {
    const bySeq = new Map(d.fixes.map((f) => [f.seq, f]));
    s.fixes.forEach((f, i) => {
      const row = bySeq.get(f.seq) ?? { seq: f.seq, t: f.t, forwardUsed: f.forwardUsed, forwardReason: null, innovation: null, finalWeight: null, finalResidual: null };
      row.finalWeight = s.smoothed!.fixWeights[i] ?? null;
      row.finalResidual = s.smoothed!.fixResiduals[i] ?? null;
      bySeq.set(f.seq, row);
    });
    d.fixes = [...bySeq.values()];
    for (const k of s.smoothed.contactLog) d.events.push({ t: k.t, type: 'ground-contact', details: { offset: k.offset, sigma: Math.sqrt(k.variance) } });
  }
  for (const p of s.steps) d.events.push({ t: p.t, type: p.stairs ? 'stair-step' : 'step', details: { length: p.length, segment: p.segment } });
  d.events.sort((a, b) => a.t - b.t);
  d.fixes.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return d;
}
