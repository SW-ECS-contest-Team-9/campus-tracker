// The one definition of "a clear, consistent height difference" for data collection and path formation.
// Rule (2026-10-10): when the clear part of the data shows such a difference, it is kept; it is never merged into one
// level or shrunk to a default storey height. Storeys on this campus are uneven (2.7 m to 5.9 m, no 4th floor), so no
// code may decide "same level" from a storey height. When the data is not clear, callers keep their earlier behaviour.
import { fusionConfigV4 } from '../fusion/fusion.config.js';
import { median, robustSigma } from './geometry.js';

export const CLEAR_HEIGHT = {
  /** paired samples needed (stations 1 m apart, or 1 s outputs): fewer is a glitch, not a level */
  minPairs: 5,
  /** smallest difference that can be clear: 3 x the phone-carrying sigma of one walk (0.3 m) = 0.9 m, about 5-6 risers */
  minDifferenceM: Math.round(3 * fusionConfigV4.phoneHeightSigmaM * 100) / 100,
  /** ...and at least this many sigmas of the comparison's own height noise (see comparisonNoiseM) */
  noiseSigmas: 3,
  /** consistent: the robust spread of the paired differences is at most this share of their median */
  maxSpreadFraction: 1 / 3,
  /** consistent: at least this share of the pairs differ in the same direction */
  minSameSignFraction: 0.9,
  /** plateaus of a height histogram (buildings:calibrate): bin, samples per plateau, and how empty the bins between two plateaus must be */
  plateauBinM: 0.5,
  plateauMinSamples: 8,
  plateauValleyFraction: 0.5,
  /** plateaus this far apart were always kept as separate levels */
  plateauAlwaysSeparateM: 2,
};

export interface HeightDifference { clear: boolean; medianM: number | null; spreadM: number | null; pairs: number; thresholdM: number }

/**
 * Are these paired height differences (a - b at the same places) one clear, consistent offset?
 * noiseM = 1-sigma height noise of the comparison (0 within one walk a short time apart; Infinity when unknown => never clear).
 */
export function clearHeightDifference(diffs: number[], noiseM = 0): HeightDifference {
  const c = CLEAR_HEIGHT;
  const values = diffs.filter((d) => Number.isFinite(d));
  const thresholdM = Math.max(c.minDifferenceM, c.noiseSigmas * noiseM);
  const m = median(values);
  const spread = robustSigma(values, m);
  const out = { medianM: m, spreadM: spread, pairs: values.length, thresholdM };
  if (m === null || spread === null || values.length < c.minPairs || !(Math.abs(m) >= thresholdM)) return { clear: false, ...out };
  const sameSign = values.filter((d) => Math.sign(d) === Math.sign(m)).length / values.length;
  return { clear: spread <= c.maxSpreadFraction * Math.abs(m) && sameSign >= c.minSameSignFraction, ...out };
}

/** Where a height came from: the fusion run, its time (ms) and the sigma of its height zero (z_datum_sigma). */
export interface HeightSource { run?: string | null; t?: number | null; sigmaZ?: number | null }

/**
 * 1-sigma noise of a height difference between two stretches of track.
 * Same run: only the barometric drift over the time between them (the zero is shared). Different runs: both zero sigmas.
 * Unknown (no run / no sigma): Infinity, so nothing is called clear and the caller behaves as before.
 */
export function comparisonNoiseM(a: HeightSource, b: HeightSource): number {
  if (a.run && a.run === b.run) {
    return a.t != null && b.t != null ? (fusionConfigV4.baroDriftMPerHour * Math.abs(a.t - b.t)) / 3_600_000 : 0;
  }
  if (a.sigmaZ == null || b.sigmaZ == null || !Number.isFinite(a.sigmaZ) || !Number.isFinite(b.sigmaZ)) return Infinity;
  return Math.hypot(a.sigmaZ, b.sigmaZ);
}

export interface Plateau { heightM: number; samples: number }

/**
 * Levels where time was spent: peaks of the height histogram (stairs only pass through).
 * Before the rule a peak within 2 m of a bigger one was dropped; now it stays when the two are clearly separate.
 */
export function heightPlateaus(values: number[]): Plateau[] {
  const c = CLEAR_HEIGHT;
  const bin = (v: number) => Math.floor(v / c.plateauBinM);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(bin(v), (counts.get(bin(v)) ?? 0) + 1);
  const n = (b: number) => counts.get(b) ?? 0;
  const peaks = [...counts.entries()]
    .filter(([b, k]) => k >= c.plateauMinSamples && k >= n(b - 1) && k >= n(b + 1))
    .sort((x, y) => y[1] - x[1]);
  const separate = (a: number, b: number) => {
    const gap = Math.abs(a - b) * c.plateauBinM;
    if (gap >= c.plateauAlwaysSeparateM) return true;
    if (gap < c.minDifferenceM) return false;
    // closer than 2 m: two levels only when the bins between them are clearly emptier than both (people do not linger there)
    let valley = Infinity;
    for (let k = Math.min(a, b) + 1; k < Math.max(a, b); k++) valley = Math.min(valley, n(k));
    return valley <= c.plateauValleyFraction * Math.min(n(a), n(b));
  };
  const chosen: number[] = [];
  for (const [b] of peaks) if (chosen.every((k) => separate(k, b))) chosen.push(b);
  return chosen
    .map((b) => {
      const nearest = Math.min(...chosen.filter((k) => k !== b).map((k) => Math.abs(k - b) * c.plateauBinM), Infinity);
      const window = Math.min(0.75, nearest / 2);
      const near = values.filter((v) => Math.abs(v - (b + 0.5) * c.plateauBinM) <= window);
      return { heightM: median(near)!, samples: near.length };
    })
    .sort((x, y) => x.heightM - y.heightM);
}

export interface CalibratedLevel { orthometricM: number; aboveEntranceM: number; relativeFloor: number; samples: number }
export interface LevelCalibration {
  floorHeightM: number;
  floorHeightSource: 'BAROMETER_LEVELS' | 'BUILDING_REGISTER' | 'DEFAULT';
  /** measured rise between consecutive plateaus, lowest first (uneven storeys stay uneven) */
  levelGapsM: number[];
  levels: CalibratedLevel[];
}

/**
 * Building levels from plateaus (phone heights) and the entrance marker height (phone height).
 * Before the rule: one storey height (median of the 2.5-5 m gaps, else register, else default) and each level's floor =
 * round(height above the entrance / that storey height), so close or tall levels shared or skipped a number.
 * Now every plateau is its own level, numbered by its order from the entrance level, with its measured height above the
 * entrance; measured gaps above 5 m give the summary storey height before the register or the default does.
 * A floor nobody walked is not counted in relativeFloor: floor names come from the building notes, not from this number.
 */
export function calibrateLevels(plateaus: Plateau[], entranceM: number, registerFloorHeightM: number | null, defaultFloorHeightM: number): LevelCalibration {
  const levels = [...plateaus].sort((a, b) => a.heightM - b.heightM);
  const gaps = levels.slice(1).map((l, i) => l.heightM - levels[i].heightM);
  const storeyLike = gaps.filter((d) => d >= 2.5 && d <= 5);
  const measured = median(storeyLike) ?? median(gaps.filter((d) => d > 5));
  const floorHeightM = measured ?? registerFloorHeightM ?? defaultFloorHeightM;
  let entranceIndex = -1;
  levels.forEach((l, i) => {
    if (Math.abs(l.heightM - entranceM) < CLEAR_HEIGHT.minDifferenceM && (entranceIndex < 0 || Math.abs(l.heightM - entranceM) < Math.abs(levels[entranceIndex].heightM - entranceM))) entranceIndex = i;
  });
  const below = levels.filter((l) => l.heightM < entranceM).length;
  const order = (i: number) => (entranceIndex >= 0 ? i - entranceIndex : i < below ? i - below : i - below + 1);
  return {
    floorHeightM,
    floorHeightSource: measured !== null ? 'BAROMETER_LEVELS' : registerFloorHeightM ? 'BUILDING_REGISTER' : 'DEFAULT',
    levelGapsM: gaps,
    levels: levels.map((l, i) => ({
      orthometricM: l.heightM,
      aboveEntranceM: l.heightM - entranceM,
      relativeFloor: order(i),
      samples: l.samples,
    })),
  };
}
