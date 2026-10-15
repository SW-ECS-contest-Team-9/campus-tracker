import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// A single .env at the repository root is shared by docker compose, backend and frontend.
// Repo root is 3 levels up from backend/src/config (tsx) and 4 from backend/dist/src/config (tsc build).
// Missing files are ignored; already-set process env vars win.
dotenv.config({
  path: [path.resolve(import.meta.dirname, '../../../.env'), path.resolve(import.meta.dirname, '../../../../.env')],
  quiet: true,
});

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1).default('postgresql://campus:campus@localhost:5432/campus'),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().default('24h'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Optional, e.g. https://collector.example.com behind a TLS proxy. Empty = derive from each request's host. */
  /** FUSION_DEBUG=true prints per-event fusion logs (~1 line/s per session plus anchors/corrections). */
  FUSION_DEBUG: z.stringbool().default(false),
  /** Fusion algorithm computed live (others are available for reprocessing). */
  ACTIVE_FUSION_VERSION: z.string().trim().default('fusion-v4'),
  /** After session:finish (or late data), replay the session this long after the LAST raw batch arrived. */
  SESSION_REPROCESS_IDLE_DELAY_MS: z.coerce.number().int().min(0).default(10_000),
  /** Realtime fusion holds samples this long to re-order slightly late ones (CMAltimeter arrives ~3 s after measuring). */
  FUSION_REORDER_WINDOW_MS: z.coerce.number().int().min(0).default(3500),
  /** A batch older than already-received data by more than this is an out-of-order/backlog arrival (fusion DIRTY). */
  OUT_OF_ORDER_TOLERANCE_MS: z.coerce.number().int().min(0).default(15_000),
  /** Sync state thresholds (preview/API): LIVE if data received within LIVE window and capture lag small; DELAYED within DELAYED window. */
  SYNC_LIVE_WINDOW_MS: z.coerce.number().int().min(0).default(15_000),
  SYNC_DELAYED_WINDOW_MS: z.coerce.number().int().min(0).default(120_000),
  /** Sensor timestamps further in the future than this (client clock error) are rejected. */
  MAX_FUTURE_TIMESTAMP_MS: z.coerce.number().int().min(0).default(86_400_000),
  /** Editor MCP endpoint (POST /mcp, docs/EDITOR_MCP_PLAN.md). off = not mounted. */
  EDITOR_MCP: z.enum(['on', 'off']).default('on'),
  /** false = /mcp answers loopback clients only (the server itself listens on the LAN for phones). */
  MCP_ALLOW_REMOTE: z.stringbool().default(false),
  /** Database vs. committed desired state (backend/data/deploy/desired-state.json) at start-up: dry-run = compare and
   * report only (apply with `npm run deploy:sync`), on = apply automatically, off = do not compare. */
  DEPLOY_RECONCILE: z.enum(['on', 'dry-run', 'off']).default('dry-run'),
  PUBLIC_BASE_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  /** BLE beacon positioning (docs/BEACON_POSITIONING.md). off = not advertised in session:start, uploads refused
   * (BEACON_DISABLED, not retryable: the apps hold the rows), config API answers with every feature off. */
  BEACON_POSITIONING: z.enum(['on', 'off']).default('on'),
  /** Remote switches handed to the apps in the beacon config (the apps also need their own local setting on). */
  BEACON_CLIENT_SCANNING: z.stringbool().default(true),
  BEACON_CLIENT_UPLOAD: z.stringbool().default(true),
  BEACON_CLIENT_FUSION: z.stringbool().default(true),
  BEACON_CLIENT_FLOOR_CORRECTION: z.stringbool().default(false),
  /** Collector IDs (comma separated) allowed to change the beacon registry. Empty = registry is read-only. */
  POSITIONING_ADMIN_COLLECTORS: z.string().default(''),
  /** Beacon config cache: the apps re-validate after maxAge, and may keep positioning with it offline for staleMax. */
  BEACON_CONFIG_MAX_AGE_S: z.coerce.number().int().min(0).default(3600),
  BEACON_CONFIG_STALE_MAX_S: z.coerce.number().int().min(0).default(14 * 86_400),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  positioningAdmins: new Set(parsed.data.POSITIONING_ADMIN_COLLECTORS.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)),
};

if (env.JWT_SECRET === 'change-me') {
  console.warn('[env] JWT_SECRET is the example value. Fine for local dev, change it anywhere else.');
}
