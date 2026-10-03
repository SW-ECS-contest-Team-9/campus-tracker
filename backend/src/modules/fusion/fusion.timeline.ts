// Shared by every fusion version: raw samples -> one deterministic, timestamp-ordered observation timeline.
// Sensors are never matched by array index; only by timestamp.
import type { CoordinateClassification, SpatialContext } from '../../geo/spatial.js';
import type { TerrainContext } from '../../geo/terrain.js';

type SensorObservation =
  | {
      kind: 'motion';
      t: number;
      seq: number;
      yaw: number | null; // CMAttitude.yaw, radians
      ax: number | null; // CMDeviceMotion.userAcceleration, in g (1 g = 9.81 m/s²)
      ay: number | null;
      az: number | null;
      rx?: number | null;
      ry?: number | null;
      rz?: number | null;
      gx?: number | null;
      gy?: number | null;
      gz?: number | null;
      roll?: number | null;
      pitch?: number | null;
      /** sensor service run (restart => new yaw reference); optional */
      segment?: string | null;
    }
  | { kind: 'pedometer'; t: number; seq: number; distance: number | null; steps: number | null; segment?: string | null } // cumulative values
  | { kind: 'altimeter'; t: number; seq: number; relativeAltitude: number | null; segment?: string | null } // cumulative per segment, meters
  | {
      kind: 'gps';
      t: number;
      seq: number;
      latitude: number;
      longitude: number;
      altitude: number | null;
      ellipsoidalAltitude: number | null;
      horizontalAccuracy: number | null;
      verticalAccuracy: number | null;
      speed: number | null; // m/s, -1 = invalid
      course: number | null; // degrees clockwise from North, -1 = invalid
      /** captured before the session started (iOS hands out its last cached fix, often minutes old) */
      preSession?: boolean;
    };

export type Observation = SensorObservation & {
  /** Fixed per-session map context, attached by fusion orchestration. Null means map data is unavailable. */
  spatialContext?: SpatialContext | null;
  /** Spatial classification is populated for GPS inputs before they reach fusion-v3. */
  spatialClassification?: CoordinateClassification;
  /** Session terrain (DEM, absolute height reference), attached by fusion orchestration; null = none. */
  terrainContext?: TerrainContext | null;
};

/**
 * Same timestamp => motion, pedometer, altimeter, then GPS: predict first, correct last, so a fix taken at
 * time t corrects the prediction made up to t. Then by per-sensor sequence. Fully deterministic.
 */
const KIND_ORDER: Record<Observation['kind'], number> = { motion: 0, pedometer: 1, altimeter: 2, gps: 3 };

export function compareObservations(a: Observation, b: Observation): number {
  return a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.seq - b.seq;
}

/** Raw sample shapes accepted by buildTimeline (telemetry DTOs and DB rows both map to these). */
export interface RawSamples {
  locations: {
    sequence: number;
    timestamp: string | Date;
    latitude: number;
    longitude: number;
    altitude?: number | null;
    ellipsoidalAltitude?: number | null;
    horizontalAccuracy?: number | null;
    verticalAccuracy?: number | null;
    speed?: number | null;
    course?: number | null;
  }[];
  motion: { sequence: number; timestamp: string | Date; yaw?: number | null; ax?: number | null; ay?: number | null; az?: number | null;
    rx?: number | null; ry?: number | null; rz?: number | null; gx?: number | null; gy?: number | null; gz?: number | null;
    roll?: number | null; pitch?: number | null; segment?: string | null }[];
  altimeter: { sequence: number; timestamp: string | Date; relativeAltitude?: number | null; segment?: string | null }[];
  pedometer: { timestamp: string | Date; distance?: number | null; numberOfSteps?: number | null; segment?: string | null }[];
}

const ms = (t: string | Date) => (t instanceof Date ? t.getTime() : Date.parse(t));
const n = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

/** A fix this much older than the session start is a cached / pre-session location, not part of the session. */
export const PRE_SESSION_GPS_TOLERANCE_MS = 30_000;

export function preSessionCutoff(sessionStartedAt: string | Date | null | undefined): number {
  return sessionStartedAt == null ? -Infinity : ms(sessionStartedAt) - PRE_SESSION_GPS_TOLERANCE_MS;
}

/** Merges all sensors into one timeline sorted by timestamp (never by array index). */
export function buildTimeline(s: RawSamples, opts: { sessionStartedAt?: string | Date | null } = {}): Observation[] {
  const cutoff = preSessionCutoff(opts.sessionStartedAt);
  const obs: Observation[] = [];
  for (const m of s.motion) {
    obs.push({ kind: 'motion', t: ms(m.timestamp), seq: m.sequence, yaw: n(m.yaw), ax: n(m.ax), ay: n(m.ay), az: n(m.az),
      rx: n(m.rx), ry: n(m.ry), rz: n(m.rz), gx: n(m.gx), gy: n(m.gy), gz: n(m.gz), roll: n(m.roll), pitch: n(m.pitch), segment: n(m.segment) });
  }
  s.pedometer.forEach((p, i) =>
    obs.push({ kind: 'pedometer', t: ms(p.timestamp), seq: i, distance: n(p.distance), steps: n(p.numberOfSteps), segment: n(p.segment) }),
  );
  for (const a of s.altimeter) obs.push({ kind: 'altimeter', t: ms(a.timestamp), seq: a.sequence, relativeAltitude: n(a.relativeAltitude), segment: n(a.segment) });
  for (const l of s.locations) {
    obs.push({
      kind: 'gps',
      t: ms(l.timestamp),
      seq: l.sequence,
      latitude: l.latitude,
      longitude: l.longitude,
      altitude: n(l.altitude),
      ellipsoidalAltitude: n(l.ellipsoidalAltitude),
      horizontalAccuracy: n(l.horizontalAccuracy),
      verticalAccuracy: n(l.verticalAccuracy),
      speed: n(l.speed),
      course: n(l.course),
      ...(ms(l.timestamp) < cutoff ? { preSession: true } : {}),
    });
  }
  return obs.filter((o) => Number.isFinite(o.t)).sort(compareObservations);
}
