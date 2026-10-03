// Angle helpers. Project heading convention: 0 = North, 90° = East, clockwise (same as CLLocation.course).

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** Normalizes any angle (radians) to [-π, π]. Use for deltas: 179° -> -179° is +2°, not -358°. */
export function normalizeAngleRad(a: number): number {
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r - Math.PI;
}

/** Heading (radians) to [0, 2π). */
export function wrapHeadingRad(a: number): number {
  const r = a % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
}

/** Heading radians -> degrees in [0, 360). */
export function headingRadToDeg(a: number): number {
  return wrapHeadingRad(a) * RAD_TO_DEG;
}

/** Shortest-arc blend: moves `from` toward `to` by fraction w (0..1). */
export function blendHeadingRad(from: number, to: number, w: number): number {
  return wrapHeadingRad(from + normalizeAngleRad(to - from) * w);
}
