import { z } from 'zod';
import { OptionalString } from '../../common/dto.js';

export const LoginRequest = z.object({
  // Collector codes are case-insensitive for typing convenience on the phone: " c03 " -> "C03"
  collectorId: z.string().trim().min(1).max(32).transform((v) => v.toUpperCase()),
  deviceId: z.string().trim().min(1).max(128),
  platform: OptionalString(32),
  deviceModel: OptionalString(64),
  systemVersion: OptionalString(32),
  appVersion: OptionalString(32),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export interface LoginResponse {
  collectorId: string;
  accessToken: string;
  /** Socket.IO server URL = the same scheme://host:port the phone used for this login request. */
  socketUrl: string;
  /** Namespace to join on socketUrl. */
  socketNamespace: '/collector';
  /** Raw WebSocket (URLSessionWebSocketTask) endpoint: ws(s)://host:port/ws/collector */
  webSocketURL: string;
}

/** Device fields that session:start may also carry (kept fresh on every start). */
export interface DeviceInfo {
  platform?: string | null;
  deviceModel?: string | null;
  systemVersion?: string | null;
  appVersion?: string | null;
}

// ---- Socket.IO /collector: collector:status (memory only, never stored) ----
export const CollectorStatusRequest = z.object({
  sessionId: z.guid().nullish(),
  collecting: z.boolean(),
  locationSampleCount: z.number().int().nonnegative().nullish(),
  motionSampleCount: z.number().int().nonnegative().nullish(),
  pendingBatchCount: z.number().int().nonnegative().nullish(),
});
export type CollectorStatusRequest = z.infer<typeof CollectorStatusRequest>;

// ---- REST: collector ID management (preview) ----
export const COLLECTOR_DELETE_CONFIRM_TEXT = '제거하겠습니다.';

const CollectorCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]{1,32}$/, 'Use 1–32 characters: A–Z, 0–9, "_" or "-"'));

/** collectorId omitted/empty -> next free C<nn> code is generated. */
export const CreateCollectorRequest = z.object({
  collectorId: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), CollectorCode.optional()),
});
export type CreateCollectorRequest = z.infer<typeof CreateCollectorRequest>;

export const CollectorCodeParam = z.object({ collectorId: CollectorCode });

export const DeleteCollectorRequest = z.object({
  confirmText: z.string().default(''),
});

export interface CollectorSummary {
  collectorId: string;
  createdAt: Date;
  deviceCount: number;
  sessionCount: number;
  activeSessionCount: number;
  locationCount: number;
  markerCount: number;
}
