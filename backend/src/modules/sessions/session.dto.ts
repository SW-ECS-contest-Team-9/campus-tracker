import { z } from 'zod';
import { IsoDateTime, OptionalString, SensorTimestamp, Uuid } from '../../common/dto.js';

export const SessionStatus = z.enum(['ACTIVE', 'FINISHED', 'INTERRUPTED']);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ---- Socket.IO /collector: session:start ----
export const SessionStartRequest = z.object({
  clientSessionId: Uuid,
  deviceId: z.string().trim().min(1).max(128),
  platform: OptionalString(32),
  deviceModel: OptionalString(64),
  systemVersion: OptionalString(32),
  appVersion: OptionalString(32),
  sensorCapabilities: z.record(z.string(), z.unknown()).default({}),
  /** When the phone actually started collecting (session started offline => sent later). Defaults to server time. */
  startedAt: SensorTimestamp.nullish(),
  /** alias of startedAt */
  clientStartedAt: SensorTimestamp.nullish(),
});
export type SessionStartRequest = z.infer<typeof SessionStartRequest>;

// ---- Socket.IO /collector: session:finish ----
const SessionRef = {
  sessionId: Uuid.nullish(),
  clientSessionId: Uuid.nullish(),
};
const needsRef = (b: { sessionId?: string | null; clientSessionId?: string | null }) => !!(b.sessionId || b.clientSessionId);
const refError = { message: 'sessionId or clientSessionId is required', path: ['sessionId'] };

/** Client's last sequence per stream: lets the server tell "all raw data arrived" (sync manifest). */
export const LastSequences = z.object({
  location: z.number().int().min(-1).nullish(),
  motion: z.number().int().min(-1).nullish(),
  altimeter: z.number().int().min(-1).nullish(),
  pedometer: z.number().int().min(-1).nullish(),
});
/** Background diagnostics (all optional, merged into collection_sessions.diagnostics). */
export const SessionDiagnostics = z.record(z.string().max(64), z.union([z.number(), z.string().max(200), z.boolean(), z.null()]));

// ---- Socket.IO / raw WS: session:finish ("collector stopped capturing"; raw upload may continue) ----
export const SessionFinishRequest = z
  .object({
    ...SessionRef,
    endedAt: SensorTimestamp.nullish(),
    interrupted: z.boolean().nullish(),
    lastSequences: LastSequences.nullish(),
    diagnostics: SessionDiagnostics.nullish(),
  })
  .refine(needsRef, refError);

// ---- session:syncComplete ("everything captured has been uploaded") ----
export const SyncCompleteRequest = z
  .object({ ...SessionRef, lastSequences: LastSequences, diagnostics: SessionDiagnostics.nullish() })
  .refine(needsRef, refError);
export type SyncCompleteRequest = z.infer<typeof SyncCompleteRequest>;

// ---- session:diagnostics (merge) ----
export const SessionDiagnosticsRequest = z.object({ ...SessionRef, diagnostics: SessionDiagnostics }).refine(needsRef, refError);
export type SessionDiagnosticsRequest = z.infer<typeof SessionDiagnosticsRequest>;

// ---- diagnostic:event (lifecycle events; NOT fusion input) ----
const DiagnosticEvent = z.object({
  eventId: Uuid.nullish(),
  eventType: z.string().trim().min(1).max(48).transform((v) => v.toUpperCase()),
  clientTimestamp: SensorTimestamp,
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export const DiagnosticEventsRequest = z
  .object({ ...SessionRef, events: z.array(DiagnosticEvent).min(1).max(500) })
  .or(z.object({ ...SessionRef, ...DiagnosticEvent.shape }).transform(({ sessionId, clientSessionId, ...e }) => ({ sessionId, clientSessionId, events: [e] })))
  .refine(needsRef, refError);
export type DiagnosticEventsRequest = z.infer<typeof DiagnosticEventsRequest>;
export type SessionFinishRequest = z.infer<typeof SessionFinishRequest>;

// ---- REST ----
export const ListSessionsQuery = z.object({
  collectorId: z.string().trim().min(1).max(32).transform((v) => v.toUpperCase()).optional(),
  status: SessionStatus.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

export const SessionIdParam = z.object({ sessionId: Uuid });

export interface SessionView {
  sessionId: string;
  clientSessionId: string;
  collectorId: string;
  device: {
    deviceId: string;
    clientDeviceId: string;
    platform: string | null;
    deviceModel: string | null;
    systemVersion: string | null;
    appVersion: string | null;
  };
  startedAt: Date;
  endedAt: Date | null;
  status: SessionStatus;
  spatialMapVersionId: string | null;
  sensorCapabilities: Record<string, unknown>;
  locationCount: number;
  markerCount: number;
  lastLocationAt: Date | null;
  // ---- collection / sync / fusion state (separate concepts) ----
  interrupted: boolean;
  createdAt: Date; // server row creation (may be later than startedAt for offline-started sessions)
  finishRequestedAt: Date | null;
  finalizedAt: Date | null;
  lastCapturedAt: Date | null; // newest sensor timestamp received
  lastReceivedAt: Date | null; // server time of the newest batch
  outOfOrderBatches: number;
  needsReprocess: boolean;
  fusionState: 'CLEAN' | 'DIRTY' | 'PROCESSING' | 'FAILED';
}

export type SyncState = 'LIVE' | 'DELAYED' | 'OFFLINE' | 'FINALIZED';

export interface LocationPointView {
  sequence: number;
  longitude: number;
  latitude: number;
  altitude: number | null;
  ellipsoidalAltitude: number | null;
  horizontalAccuracy: number | null;
  verticalAccuracy: number | null;
  speed: number | null;
  course: number | null;
  timestamp: Date;
  receivedAt: Date;
  captureSource: string;
}
