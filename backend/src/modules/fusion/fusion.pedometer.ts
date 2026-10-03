// CMPedometer steps / distance are cumulative per pedometer run (one sensorSegmentId).
//
// Real uploads interleave samples of 0 steps / 0 m into that stream, after which it continues at its old
// total (158, 0, 158, ...). Taking the drop as a counter reset made the next sample look like a walk of the
// whole total (clamped to a ~5 m phantom jump). Rule shared by the fusion engines and the validation:
//  - only a value above the run's high-water mark adds distance; the delta is measured from that maximum
//  - a value below it is ignored and never becomes the baseline
//  - a counter that really restarted without a new segment id keeps counting up from its new base:
//    after PEDOMETER_RESET_CONFIRM_INCREASES increases in a row below the mark, that becomes the baseline
//    (the steps counted before the confirmation are not applied in a lump)
//  - a new sensorSegmentId (the documented way to restart the pedometer) starts a fresh counter right away
// Raw samples are never changed; this only decides what fusion uses.

export const PEDOMETER_RESET_CONFIRM_INCREASES = 2;

export interface PedometerCounter {
  maxSteps?: number;
  maxDistance?: number;
  /** consecutive samples below the high-water mark (restart candidate) */
  lowRun?: { steps: number | null; distance: number | null; increases: number };
}

export type PedometerVerdict = 'OK' | 'BELOW_HIGH_WATER' | 'COUNTER_RESTARTED';

export const createPedometerCounter = (): PedometerCounter => ({});

/** First sample of the session or of a new pedometer segment: it is the baseline. */
export function restartPedometerCounter(c: PedometerCounter, steps: number | null, distance: number | null) {
  c.maxSteps = steps ?? undefined;
  c.maxDistance = distance ?? undefined;
  c.lowRun = undefined;
}

/** Classifies the next sample of the current run and advances the high-water marks. */
export function checkPedometerCounter(c: PedometerCounter, steps: number | null, distance: number | null): PedometerVerdict {
  const below =
    (steps !== null && c.maxSteps !== undefined && steps < c.maxSteps) ||
    (distance !== null && c.maxDistance !== undefined && distance < c.maxDistance);
  if (!below) {
    c.lowRun = undefined;
    if (steps !== null) c.maxSteps = Math.max(c.maxSteps ?? steps, steps);
    if (distance !== null) c.maxDistance = Math.max(c.maxDistance ?? distance, distance);
    return 'OK';
  }
  const run = c.lowRun;
  const increased =
    run !== undefined &&
    ((steps !== null && run.steps !== null && steps > run.steps) || (distance !== null && run.distance !== null && distance > run.distance));
  c.lowRun = { steps, distance, increases: increased ? run!.increases + 1 : 0 };
  if (c.lowRun.increases >= PEDOMETER_RESET_CONFIRM_INCREASES) {
    restartPedometerCounter(c, steps, distance);
    return 'COUNTER_RESTARTED';
  }
  return 'BELOW_HIGH_WATER';
}
