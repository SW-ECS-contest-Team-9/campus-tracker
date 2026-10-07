import type { Namespace, Server, Socket } from 'socket.io';
import { z } from 'zod';
import { verifyAccessToken, type CollectorIdentity } from '../common/auth/jwt.js';
import { collectorService } from '../modules/collectors/collector.service.js';
import { logger } from '../common/logger.js';
import { Uuid } from '../common/dto.js';
import { AppError, toErrorBody } from '../common/errors/app-error.js';
import { pool } from '../config/database.js';

const room = 'campus:main';
const XYZ = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
type Selection = { objectType: 'road' | 'place'; objectId: string } | null;
const presence = new Map<string, { collectorId: string; sessionId: string; cursor: [number, number, number] | null; heading: number; at: number;
  /** Set for AI agents working through MCP: they have no socket and are kept alive by their tool calls. */
  agent?: string; selected?: Selection }>();
/** Transient map annotations shown by agents (proposals, highlighted findings). Nothing here is saved. */
export interface OverlayItem { kind: 'point' | 'line'; coordinates: [number, number, number][]; label?: string; style: 'proposal' | 'highlight' | 'remove' }
const overlays = new Map<string, { key: string; collectorId: string; agent: string; items: OverlayItem[]; expiresAt: number }>();
const AGENT_IDLE_MS = 90_000;
const activeDrafts = new Map<string, { socketId: string; payload: unknown }>();
let namespace: Namespace | null = null;

interface EditorSocket extends Socket {
  data: { identity?: CollectorIdentity; editorSessionId?: string };
}

export function registerEditorGateway(io: Server) {
  namespace = io.of('/editor');
  namespace.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
      if (!token) throw AppError.unauthorized('TOKEN_REQUIRED', 'Sign in with an existing tracker account');
      const identity = verifyAccessToken(token);
      await collectorService.touchDevice(identity);
      const sessionId = Uuid.parse(socket.handshake.auth?.sessionId);
      (socket as EditorSocket).data.identity = identity;
      (socket as EditorSocket).data.editorSessionId = sessionId;
      next();
    } catch (err) {
      const { body } = toErrorBody(err);
      next(Object.assign(new Error(body.message), { data: body }));
    }
  });

  namespace.on('connection', (raw) => {
    const socket = raw as EditorSocket;
    const collectorId = socket.data.identity!.collectorId;
    const sessionId = socket.data.editorSessionId!;
    const key = `${socket.id}`;
    void socket.join(room);
    presence.set(key, { collectorId, sessionId, cursor: null, heading: 0, at: Date.now() });
    socket.emit('editor:presence:snapshot', [...presence.entries()].map(([socketId, p]) => ({ socketId, ...p })));
    socket.emit('editor:draft:snapshot', [...activeDrafts.values()].map(({ payload }) => payload));
    socket.emit('editor:overlay:snapshot', [...overlays.values()]);
    socket.to(room).emit('editor:presence:joined', { socketId: key, collectorId, sessionId });
    let lastCursorAt = 0;
    let lastDraftAt = 0;
    const lastDraftSeq = new Map<string, number>();
    const lastDraftLeaseToken = new Map<string, string>();

    socket.on('editor:cursor:update', (input: unknown) => {
      const now = Date.now();
      if (now - lastCursorAt < 33) return;
      lastCursorAt = now;
      const parsed = z.object({ coordinate: XYZ.nullable(), heading: z.number().finite().min(-360_000).max(360_000) }).safeParse(input);
      if (!parsed.success) return;
      const value = presence.get(key);
      if (!value) return;
      value.cursor = parsed.data.coordinate;
      value.heading = parsed.data.heading;
      value.at = now;
      socket.to(room).volatile.emit('editor:cursor:update', { socketId: key, collectorId, sessionId, ...parsed.data, at: now });
    });

    socket.on('editor:selection:update', (input: unknown) => {
      const parsed = z.object({ objectType: z.enum(['road', 'place']), objectId: Uuid }).nullable().safeParse(input);
      const value = presence.get(key);
      if (parsed.success && value) value.selected = parsed.data;
    });

    socket.on('editor:draft:update', async (input: unknown, ack?: (result: unknown) => void) => {
      const parsed = z.object({
        objectType: z.enum(['road', 'place']), objectId: Uuid, leaseToken: Uuid,
        baseRevision: z.number().int().nonnegative(), draftSeq: z.number().int().nonnegative(),
        draft: z.union([
          z.object({ coordinates: z.array(XYZ).max(20_000), attrs: z.record(z.string(), z.unknown()).optional() }),
          z.object({ coordinate: XYZ, attrs: z.record(z.string(), z.unknown()).optional() }),
        ]),
      }).safeParse(input);
      if (!parsed.success) { ack?.({ ok: false, code: 'INVALID_DRAFT' }); return; }
      if ((parsed.data.objectType === 'road') !== ('coordinates' in parsed.data.draft)) { ack?.({ ok: false, code: 'INVALID_DRAFT_TYPE' }); return; }
      if (JSON.stringify(parsed.data.draft).length > 256_000) { ack?.({ ok: false, code: 'DRAFT_TOO_LARGE' }); return; }
      const now = Date.now();
      if (now - lastDraftAt < 80) { ack?.({ ok: false, code: 'DRAFT_RATE_LIMITED' }); return; }
      lastDraftAt = now;
      const key = `${parsed.data.objectType}:${parsed.data.objectId}`;
      if (parsed.data.draftSeq <= (lastDraftSeq.get(key) ?? -1)) { ack?.({ ok: false, code: 'STALE_DRAFT' }); return; }
      try {
        const { rows } = await pool.query<{ revision: number | null }>(`SELECT CASE WHEN $1='road'
            THEN (SELECT revision FROM mobility.road_segments WHERE id=$2 AND status IN ('DRAFT','APPROVED'))
            ELSE (SELECT revision FROM mobility.places WHERE id=$2 AND status IN ('DRAFT','APPROVED')) END AS revision
          FROM mobility.editor_leases WHERE object_type=$1 AND object_id=$2 AND lease_token=$3
            AND owner_code=$4 AND session_id=$5 AND expires_at>now()`,
          [parsed.data.objectType, parsed.data.objectId, parsed.data.leaseToken, collectorId, sessionId]);
        if (!rows.length) { ack?.({ ok: false, code: 'EDITOR_LEASE_LOST' }); return; }
        if ((parsed.data.baseRevision === 0 && rows[0].revision !== null) || (parsed.data.baseRevision > 0 && rows[0].revision !== parsed.data.baseRevision)) {
          ack?.({ ok: false, code: 'STALE_DRAFT' }); return;
        }
        if (parsed.data.draftSeq <= (lastDraftSeq.get(key) ?? -1)) { ack?.({ ok: false, code: 'STALE_DRAFT' }); return; }
        lastDraftSeq.set(key, parsed.data.draftSeq);
        lastDraftLeaseToken.set(key, parsed.data.leaseToken);
        const payload = { ...parsed.data, collectorId, sessionId, at: now };
        activeDrafts.set(key, { socketId: socket.id, payload });
        socket.to(room).emit('editor:draft:update', payload);
        ack?.({ ok: true });
      } catch (err) {
        logger.warn('editor.draft_failed', { collectorId, message: err instanceof Error ? err.message : String(err) });
        ack?.({ ok: false, code: 'DRAFT_UNAVAILABLE' });
      }
    });

    socket.on('editor:draft:clear', async (input: unknown) => {
      const parsed = z.object({ objectType: z.enum(['road', 'place']), objectId: Uuid, leaseToken: Uuid }).safeParse(input);
      if (!parsed.success) return;
      try {
        const key = `${parsed.data.objectType}:${parsed.data.objectId}`;
        const { rows } = await pool.query<{ lease_token: string; owner_code: string; session_id: string }>(`SELECT lease_token,owner_code,session_id FROM mobility.editor_leases WHERE object_type=$1 AND object_id=$2 AND expires_at>now()`,
          [parsed.data.objectType, parsed.data.objectId]);
        const currentLeaseMatches = rows[0]?.lease_token === parsed.data.leaseToken
          && rows[0]?.owner_code === collectorId && rows[0]?.session_id === sessionId;
        const recentlyOwned = !rows.length && lastDraftLeaseToken.get(key) === parsed.data.leaseToken;
        if (!currentLeaseMatches && !recentlyOwned) return;
        lastDraftSeq.delete(key); lastDraftLeaseToken.delete(key);
        if (activeDrafts.get(key)?.socketId === socket.id) {
          activeDrafts.delete(key);
          socket.to(room).emit('editor:draft:clear', { ...parsed.data, collectorId, sessionId });
        }
      } catch (err) { logger.warn('editor.draft_clear_failed', { collectorId, message: err instanceof Error ? err.message : String(err) }); }
    });

    socket.on('disconnect', () => {
      for (const key of lastDraftSeq.keys()) {
        const [objectType, objectId] = key.split(':');
        if (activeDrafts.get(key)?.socketId === socket.id) {
          activeDrafts.delete(key);
          socket.to(room).emit('editor:draft:clear', { objectType, objectId, collectorId, sessionId });
        }
      }
      presence.delete(key);
      socket.to(room).emit('editor:presence:left', { socketId: key, collectorId, sessionId });
      logger.info('editor.disconnected', { collectorId, socketId: key });
    });
    logger.info('editor.connected', { collectorId, socketId: key });
  });
}

/** Who is connected right now and which unsaved drafts they are showing (memory only). */
export const editorPresence = {
  snapshot: () => ({
    participants: [...presence.entries()].map(([socketId, p]) => ({ socketId, ...p })),
    drafts: [...activeDrafts.values()].map(({ payload }) => payload),
  }),
};

export interface AgentRef { collectorId: string; sessionId: string; agent: string }
const agentKey = (a: AgentRef) => `agent:${a.sessionId}`;

function sweepAgents() {
  const now = Date.now();
  for (const [key, p] of presence) {
    if (!p.agent || now - p.at < AGENT_IDLE_MS) continue;
    presence.delete(key);
    namespace?.to(room).emit('editor:presence:left', { socketId: key, collectorId: p.collectorId, sessionId: p.sessionId });
  }
  for (const [key, o] of overlays) {
    if (o.expiresAt > now) continue;
    overlays.delete(key);
    namespace?.to(room).emit('editor:overlay:clear', { key });
  }
}
setInterval(sweepAgents, 5_000).unref();

/** AI agents as editor participants: same presence/cursor events as a browser tab, driven by MCP tool calls. */
export const editorAgents = {
  /** Marks the agent as present (joining if needed) and optionally moves its cursor to where it is working. */
  touch(a: AgentRef, cursor?: [number, number, number]) {
    const key = agentKey(a), now = Date.now();
    const existing = presence.get(key);
    if (!existing) {
      presence.set(key, { collectorId: a.collectorId, sessionId: a.sessionId, cursor: cursor ?? null, heading: 0, at: now, agent: a.agent });
      namespace?.to(room).emit('editor:presence:joined', { socketId: key, collectorId: a.collectorId, sessionId: a.sessionId, agent: a.agent });
    } else { existing.at = now; if (cursor) existing.cursor = cursor; }
    if (cursor) namespace?.to(room).emit('editor:cursor:update', { socketId: key, collectorId: a.collectorId, sessionId: a.sessionId, agent: a.agent, coordinate: cursor, heading: 0, at: now });
  },
  overlay(a: AgentRef, items: OverlayItem[], ttlSec: number) {
    const key = agentKey(a);
    const value = { key, collectorId: a.collectorId, agent: a.agent, items, expiresAt: Date.now() + ttlSec * 1000 };
    overlays.set(key, value);
    namespace?.to(room).emit('editor:overlay:set', value);
    return { viewers: [...presence.values()].filter((p) => !p.agent).length };
  },
  clearOverlay(a: AgentRef) {
    const key = agentKey(a);
    if (overlays.delete(key)) namespace?.to(room).emit('editor:overlay:clear', { key });
  },
  /** Asks open editors to look at a place. Each browser decides whether to follow (opt-in setting). */
  focus(a: AgentRef, coordinate: [number, number, number], rangeM: number, label?: string) {
    namespace?.to(room).emit('editor:view:focus', { collectorId: a.collectorId, agent: a.agent, coordinate, rangeM, label });
    return { viewers: [...presence.values()].filter((p) => !p.agent).length };
  },
};

export const editorBroadcast = {
  change: (event: unknown) => {
    if (event && typeof event === 'object' && 'objectType' in event && 'objectId' in event
      && typeof event.objectType === 'string' && typeof event.objectId === 'string'
      // a colour change does not end someone's live geometry draft of that road
      && !(event as { payload?: { style?: unknown } }).payload?.style) {
      activeDrafts.delete(`${event.objectType}:${event.objectId}`);
    }
    namespace?.to(room).emit('editor:feature:changed', event);
  },
  lease: (event: unknown) => namespace?.to(room).emit('editor:lease:changed', event),
};
