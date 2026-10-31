/**
 * fusion-v4 rev 18: registered BLE beacons as a measurement source (pure: no DB, no clock). docs/BEACON_POSITIONING.md
 *
 * Pipeline per observation: identity (resolved at load: only enabled, anchored beacons reach fusion) -> RSSI range check
 * -> per-beacon window (median, MAD outlier rejection, stale samples dropped) -> RSSI model (calibration) -> likelihood
 * -> EKF update over the same state [x, y, theta] as GPS (forward) / RTS smoother (replay).
 *
 * Measurement model (log-distance path loss): RSSI = P1m - 10 n log10(d) + e, e ~ N(0, s^2). In log-range space this is
 * Gaussian and independent of d:  ln d_model = ln d + e',  sd(e') = s ln10 / (10 n). So the measurement is
 *   z = ln d_model,  h(x) = 0.5 ln((x - ax)^2 + (y - ay)^2 + dz^2),  H = [(x - ax) / r^2, (y - ay) / r^2, 0]
 * with dz the vertical offset between the anchor and the phone on the same floor. A near beacon (upper 2-sigma range
 * below a few metres) is used as a proximity REGION instead: a Gaussian around the anchor whose sigma is that upper
 * range, never a jump to the anchor (gated, and one update moves the state at most beaconMaxShiftM).
 */
import { tmInverse } from '../../geo/tm.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import type { LocalOrigin } from '../../geo/wgs84.js';
import { floorName, floorNumber } from '../markers/marker-anchor.js';
import { lnRangeSigma, modelRange } from '../positioning/beacon-calibration.js';
import type { FusionConfigV4 } from './fusion.config.js';
import type { BeaconMeasurementInput } from './fusion.timeline.js';
import { gpsUpdate, sigmaXY, type Mat3, type Vec3 } from './fusion-v4.smoother.js';

export type BeaconRejectReason = 'RSSI_OUT_OF_RANGE' | 'RSSI_OUTLIER' | 'TOO_FAR' | 'STALE' | 'NOT_INITIALIZED' | 'PRIOR_TOO_WIDE'
  | 'FLOOR_MISMATCH' | 'INNOVATION_GATED' | 'DISABLED' | 'INCONSISTENT_HEIGHT';

/** One filtered beacon measurement (what the EKF and the smoother consume). Anchor in local ENU metres. */
export interface BeaconRangeMeasurement {
  t: number;
  beaconId: string;
  /** anchor in EPSG:5186 (kept so the smoother can re-project if the local origin is known only later) */
  gridX: number;
  gridY: number;
  buildingId: string;
  floor: string | null;
  /** vertical offset anchor - phone on the anchor's floor, m */
  dz: number;
  /** model 3D range (m), ln of it = z, and the variance of z */
  range: number;
  lnRange: number;
  variance: number;
  /** upper 2-sigma model range (3D) and its horizontal part: below beaconProximityMaxRangeM horizontally = proximity */
  upperRange: number;
  upperHorizontal: number;
  proximity: boolean;
  samples: number;
}

interface Channel { samples: { t: number; rssi: number; n: number }[]; lastUpdateT?: number }

export interface FloorEstimate {
  floor: string | null;
  buildingId: string | null;
  source: 'BEACON' | 'BEACON_BAROMETER' | 'BAROMETER' | null;
  confidence: number | null;
}

export interface FloorTracker extends FloorEstimate {
  votes: { t: number; key: string; w: number }[];
  candidate?: { key: string; since: number };
  /** barometric Z when the current floor was confirmed (or last re-referenced on it) */
  zRef?: number;
  /** floor surface heights (MSL) the anchors gave, per "building|floor" */
  floorHeights: Record<string, number>;
  changes: { t: number; from: string | null; to: string; buildingId: string; source: string; confidence: number; dz: number | null }[];
  /** confirmed floor contacts for the optional Z datum: b = floor height + phone height - baro Z */
  heightContacts: { t: number; offset: number; variance: number; floor: string; buildingId: string }[];
}

export interface BeaconTracker {
  channels: Record<string, Channel>;
  /** measurements in time order for the smoother (forward decisions do not remove them; the smoother gates again) */
  measurements: BeaconRangeMeasurement[];
  counters: { observations: number; measurements: number; applied: number; proximity: number; rejected: Record<string, number> };
  floor: FloorTracker;
  /** beacon range updates applied in the current output window (diagnostics) */
  windowUpdates: number;
}

export function createBeaconTracker(): BeaconTracker {
  return {
    channels: {},
    measurements: [],
    counters: { observations: 0, measurements: 0, applied: 0, proximity: 0, rejected: {} },
    floor: { floor: null, buildingId: null, source: null, confidence: null, votes: [], floorHeights: {}, changes: [], heightContacts: [] },
    windowUpdates: 0,
  };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function rejectBeacon(tr: BeaconTracker, reason: BeaconRejectReason) {
  tr.counters.rejected[reason] = (tr.counters.rejected[reason] ?? 0) + 1;
}

/**
 * RSSI filtering for one observation. Returns a measurement when this beacon is due for an update, null when the
 * sample was only added to the window (or rejected: counted in tr.counters.rejected).
 */
export function filterBeacon(tr: BeaconTracker, t: number, o: BeaconMeasurementInput, c: FusionConfigV4): BeaconRangeMeasurement | null {
  tr.counters.observations++;
  if (!Number.isFinite(o.rssi) || o.rssi < c.beaconMinRssiDbm || o.rssi > c.beaconMaxRssiDbm) {
    rejectBeacon(tr, 'RSSI_OUT_OF_RANGE');
    return null;
  }
  const ch = (tr.channels[o.beaconId] ??= { samples: [] });
  ch.samples = ch.samples.filter((s) => s.t > t - c.beaconWindowMs && s.t <= t);
  if (ch.samples.length >= 3) {
    // a sudden spike against this beacon's own recent RSSI (reflection, body block, a spoofer close to the phone)
    const m = median(ch.samples.map((s) => s.rssi));
    const mad = median(ch.samples.map((s) => Math.abs(s.rssi - m)));
    if (Math.abs(o.rssi - m) > Math.max(c.beaconOutlierMinDb, 3 * 1.4826 * mad)) {
      rejectBeacon(tr, 'RSSI_OUTLIER');
      return null;
    }
  }
  ch.samples.push({ t, rssi: o.rssi, n: Math.max(1, o.sampleCount ?? 1) });
  if (ch.lastUpdateT !== undefined && t - ch.lastUpdateT < c.beaconUpdateIntervalMs) return null;
  ch.lastUpdateT = t;
  const rssi = median(ch.samples.map((s) => s.rssi));
  const samples = Math.min(c.beaconMaxEffectiveSamples, ch.samples.reduce((a, s) => a + s.n, 0));
  const model = { measuredPower1m: o.measuredPower1m, pathLossExponent: o.pathLossExponent };
  const range = Math.max(c.beaconMinRangeM, modelRange(rssi, model));
  if (range > c.beaconMaxRangeM) {
    rejectBeacon(tr, 'TOO_FAR');
    return null;
  }
  const lnSigma = lnRangeSigma(o.rssiVariance, o.pathLossExponent);
  const variance = lnSigma ** 2 / samples + (o.anchorHorizontalAccuracyM / Math.max(range, 1)) ** 2;
  const mount = o.floorHeightM !== null && Number.isFinite(o.floorHeightM) ? o.anchorZ - o.floorHeightM : c.beaconDefaultMountAboveFloorM;
  const dz = Math.max(0.3, Math.abs(mount - c.phoneHeightM));
  const upperRange = range * Math.exp(2 * Math.sqrt(variance));
  // A 3-D range shorter than the vertical separation cannot establish proximity to the anchor.
  if (upperRange < dz) {
    rejectBeacon(tr, 'INCONSISTENT_HEIGHT');
    return null;
  }
  const upperHorizontal = Math.sqrt(Math.max(0, upperRange ** 2 - dz ** 2));
  const m: BeaconRangeMeasurement = {
    t, beaconId: o.beaconId, gridX: o.anchorX, gridY: o.anchorY, buildingId: o.buildingId, floor: o.floor, dz,
    range, lnRange: Math.log(range), variance, upperRange, upperHorizontal, proximity: upperHorizontal <= c.beaconProximityMaxRangeM, samples,
  };
  tr.counters.measurements++;
  if (o.floor && o.floorHeightM !== null && Number.isFinite(o.floorHeightM)) tr.floor.floorHeights[`${o.buildingId}|${o.floor}`] = o.floorHeightM;
  return m;
}

/** Anchor in the session's local ENU frame (EPSG:5186 -> WGS84 -> local, like the node anchors). */
export function anchorLocal(origin: LocalOrigin, m: Pick<BeaconRangeMeasurement, 'gridX' | 'gridY'>): { x: number; y: number } {
  const ll = tmInverse(m.gridX, m.gridY);
  const p = wgs84ToLocal(origin, ll.latitude, ll.longitude, 0);
  return { x: p.x, y: p.y };
}

export interface BeaconUpdateResult { x: Vec3; P: Mat3; d2: number; applied: boolean; reason: BeaconRejectReason | null; mode: 'RANGE' | 'PROXIMITY' }

const sym = (a: Mat3): Mat3 => [a[0], (a[1] + a[3]) / 2, (a[2] + a[6]) / 2, (a[1] + a[3]) / 2, a[4], (a[5] + a[7]) / 2, (a[2] + a[6]) / 2, (a[5] + a[7]) / 2, a[8]];

/**
 * One beacon measurement against the state. Proximity: 2-D region update around the anchor. Otherwise: scalar EKF update in
 * ln(range). Both: chi-square gate (rejected = no change), Huber-like variance inflation above beaconRobustChi2, and the
 * variance raised further if the update would move the position more than beaconMaxShiftM (no jumps to the anchor).
 * gate = false: the replay smoother's own pass, where the forward decisions are not repeated (gate still applies to wild ones).
 */
export function beaconUpdate(x: Vec3, P: Mat3, m: BeaconRangeMeasurement, anchor: { x: number; y: number }, c: FusionConfigV4): BeaconUpdateResult {
  const prior = sigmaXY(P);
  if (m.proximity) {
    let r = Math.max(m.upperHorizontal, c.beaconProximitySigmaFloorM) ** 2;
    let u = gpsUpdate(x, P, anchor.x, anchor.y, r);
    if (u.d2 > c.beaconProximityGateChi2) return { x, P, d2: u.d2, applied: false, reason: 'INNOVATION_GATED', mode: 'PROXIMITY' };
    if (u.d2 > c.beaconProximityRobustChi2) {
      r *= u.d2 / c.beaconProximityRobustChi2;
      u = gpsUpdate(x, P, anchor.x, anchor.y, r);
    }
    for (let k = 0; k < 8; k++) {
      const shift = Math.hypot(u.x[0] - x[0], u.x[1] - x[1]);
      if (shift <= c.beaconMaxShiftM) break;
      r *= (shift / c.beaconMaxShiftM) ** 2;
      u = gpsUpdate(x, P, anchor.x, anchor.y, r);
    }
    return { x: u.x, P: u.P, d2: u.d2, applied: true, reason: null, mode: 'PROXIMITY' };
  }
  if (prior > c.beaconMaxPriorSigmaM) return { x, P, d2: 0, applied: false, reason: 'PRIOR_TOO_WIDE', mode: 'RANGE' };
  const dx = x[0] - anchor.x;
  const dy = x[1] - anchor.y;
  const r2 = dx * dx + dy * dy + m.dz * m.dz;
  const H0 = dx / r2;
  const H1 = dy / r2;
  const nu = m.lnRange - 0.5 * Math.log(r2);
  // P H^T (3) and H P H^T
  const ph = [P[0] * H0 + P[1] * H1, P[3] * H0 + P[4] * H1, P[6] * H0 + P[7] * H1];
  const hph = H0 * ph[0] + H1 * ph[1];
  let R = m.variance;
  let S = hph + R;
  const d2 = (nu * nu) / S;
  if (d2 > c.beaconGateChi2) return { x, P, d2, applied: false, reason: 'INNOVATION_GATED', mode: 'RANGE' };
  if (d2 > c.beaconRobustChi2) {
    R *= d2 / c.beaconRobustChi2;
    S = hph + R;
  }
  const gainXY = Math.hypot(ph[0], ph[1]);
  const shift = (gainXY * Math.abs(nu)) / S;
  if (shift > c.beaconMaxShiftM) {
    R = (gainXY * Math.abs(nu)) / c.beaconMaxShiftM - hph;
    S = hph + R;
  }
  const K = [ph[0] / S, ph[1] / S, ph[2] / S];
  const xn: Vec3 = [x[0] + K[0] * nu, x[1] + K[1] * nu, x[2] + K[2] * nu];
  // Joseph-free form is fine for a scalar update with an exact gain: P - (P H^T)(P H^T)^T / S
  const Pn = P.slice();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Pn[3 * i + j] -= (ph[i] * ph[j]) / S;
  return { x: xn, P: sym(Pn), d2, applied: true, reason: null, mode: 'RANGE' };
}

// ---------------------------------------------------------------------------------------------
// floor estimation: beacon floor votes + barometric relative Z + stair steps, with persistence
// ---------------------------------------------------------------------------------------------

const key = (buildingId: string, floor: string) => `${buildingId}|${floor}`;
const parseKey = (k: string) => { const i = k.lastIndexOf('|'); return { buildingId: k.slice(0, i), floor: k.slice(i + 1) }; };
/** 1F and B1 are one storey apart (there is no floor 0). */
const level = (floor: string) => { const n = floorNumber(floor)!; return n > 0 ? n - 1 : n; };
const fromLevel = (l: number) => floorName(l >= 0 ? l + 1 : l);

/** A near beacon votes for its floor (closer = stronger); far beacons leak through floors and do not vote. */
export function voteFloor(ft: FloorTracker, m: BeaconRangeMeasurement, c: FusionConfigV4) {
  if (!m.floor || floorNumber(m.floor) === null || m.range > c.beaconFloorVoteMaxRangeM) return;
  ft.votes.push({ t: m.t, key: key(m.buildingId, m.floor), w: 1 / Math.max(m.range, 1) });
}

/** Expected barometric change from one floor to another of the same building (anchor floor heights, else default). */
function expectedDz(ft: FloorTracker, buildingId: string, from: string, to: string, c: FusionConfigV4): number {
  const a = ft.floorHeights[key(buildingId, from)];
  const b = ft.floorHeights[key(buildingId, to)];
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a;
  return (level(to) - level(from)) * c.beaconFloorHeightDefaultM;
}

export type FloorEvent = { type: 'floor'; t: number; from: string | null; to: string; buildingId: string; source: NonNullable<FloorEstimate['source']>; confidence: number; dz: number | null };

/**
 * Re-evaluates the floor at time t. z = barometric relative Z (undefined: no barometer). verticalSteps = stairs / slope
 * steps were detected recently (IMU evidence of a vertical move). A beacon majority alone never changes a confirmed floor:
 * it must lead for beaconFloorChangeMs AND the barometer must have moved the expected way (or, without a barometer,
 * lead much longer and more clearly). The barometer alone moves the floor only after more than one storey without beacons.
 */
export function updateFloor(ft: FloorTracker, t: number, z: number | undefined, verticalSteps: boolean, c: FusionConfigV4): FloorEvent | null {
  ft.votes = ft.votes.filter((v) => v.t > t - c.beaconFloorWindowMs && v.t <= t);
  const totals = new Map<string, number>();
  let sum = 0;
  for (const v of ft.votes) { totals.set(v.key, (totals.get(v.key) ?? 0) + v.w); sum += v.w; }
  let leader: string | null = null;
  let best = 0;
  for (const [k, w] of totals) if (w > best || (w === best && leader !== null && k < leader)) { leader = k; best = w; }
  const share = sum > 0 ? best / sum : 0;
  const current = ft.floor && ft.buildingId ? key(ft.buildingId, ft.floor) : null;
  const zKnown = z !== undefined && Number.isFinite(z);

  const confirm = (k: string, source: NonNullable<FloorEstimate['source']>, confidence: number, dz: number | null): FloorEvent => {
    const { buildingId, floor } = parseKey(k);
    const ev: FloorEvent = { type: 'floor', t, from: ft.floor, to: floor, buildingId, source, confidence, dz };
    ft.changes.push({ t, from: ft.floor, to: floor, buildingId, source, confidence, dz });
    ft.floor = floor;
    ft.buildingId = buildingId;
    ft.source = source;
    ft.confidence = confidence;
    ft.zRef = zKnown ? z : undefined;
    ft.candidate = undefined;
    return ev;
  };

  if (!sum) {
    // barometer only (no beacon in range, e.g. an elevator ride): a whole number of storeys away from the confirmed floor
    if (!current || !zKnown || ft.zRef === undefined) return null;
    const dz = z! - ft.zRef;
    const storey = Math.abs(expectedDz(ft, ft.buildingId!, ft.floor!, fromLevel(level(ft.floor!) + Math.sign(dz || 1)), c)) || c.beaconFloorHeightDefaultM;
    const moved = Math.round(dz / storey);
    if (moved === 0 || Math.abs(dz) < c.beaconFloorBaroOnlyFraction * storey || Math.abs(dz - moved * storey) > 0.3 * storey) return null;
    const to = fromLevel(level(ft.floor!) + moved);
    if (!/^(B[1-9]|[1-9][0-9]?F)$/.test(to)) return null;
    return confirm(key(ft.buildingId!, to), 'BAROMETER', 0.5, dz);
  }

  if (leader === current) {
    ft.candidate = undefined;
    ft.confidence = share;
    // re-reference the barometer on a level stretch of the confirmed floor (slow weather drift), never mid-climb
    if (zKnown && ft.zRef !== undefined && !verticalSteps && Math.abs(z! - ft.zRef) < 0.3 * c.beaconFloorHeightDefaultM) ft.zRef = z;
    if (zKnown && ft.zRef === undefined) ft.zRef = z;
    return null;
  }
  if (share < c.beaconFloorMinShare || leader === null) { ft.candidate = undefined; return null; }
  if (!ft.candidate || ft.candidate.key !== leader) ft.candidate = { key: leader, since: t };
  const lead = t - ft.candidate.since;
  if (!current) return lead >= c.beaconFloorConfirmMs ? confirm(leader, 'BEACON', share, null) : null;

  const next = parseKey(leader);
  if (next.buildingId !== ft.buildingId) {
    // another building: buildings are entered on foot at a level, the beacons decide (with persistence)
    return lead >= c.beaconFloorChangeMs ? confirm(leader, 'BEACON', share, null) : null;
  }
  if (!zKnown || ft.zRef === undefined) {
    return lead >= c.beaconFloorNoBaroChangeMs && share >= 0.8 ? confirm(leader, 'BEACON', share, null) : null;
  }
  if (lead < c.beaconFloorChangeMs) return null;
  const expected = expectedDz(ft, next.buildingId, ft.floor!, next.floor, c);
  const dz = z! - ft.zRef;
  const fraction = verticalSteps ? 0.75 * c.beaconFloorChangeMinDzFraction : c.beaconFloorChangeMinDzFraction;
  if (Math.sign(dz) !== Math.sign(expected) || Math.abs(dz) < fraction * Math.abs(expected)) return null; // floor leak, not a move
  return confirm(leader, 'BEACON_BAROMETER', share, dz);
}

/** Height-zero observation on a confirmed beacon floor: offset b = floor surface + phone height - barometric Z. */
export function floorHeightContact(ft: FloorTracker, t: number, z: number | undefined, c: FusionConfigV4) {
  if (!ft.floor || !ft.buildingId || z === undefined || !Number.isFinite(z) || (ft.confidence ?? 0) < c.beaconFloorMinShare) return;
  const h = ft.floorHeights[key(ft.buildingId, ft.floor)];
  if (!Number.isFinite(h)) return;
  const last = ft.heightContacts.at(-1);
  if (last && t - last.t < 5000) return; // thinned like the ground contacts
  ft.heightContacts.push({ t, offset: h + c.phoneHeightM - z, variance: c.beaconFloorHeightSigmaM ** 2 + c.phoneHeightSigmaM ** 2,
    floor: ft.floor, buildingId: ft.buildingId });
}

export function floorEstimate(ft: FloorTracker): FloorEstimate {
  return { floor: ft.floor, buildingId: ft.buildingId, source: ft.source, confidence: ft.confidence };
}
