// Fixed floor colours for the network editor: colour carries the floor, line shape carries the road type
// (two variables on two visual channels instead of both on colour). Low floors are dark, high floors vivid.
// The table is fixed so the same floor has the same colour for everyone, in every session.

export const FLOOR_COLORS: Readonly<Record<number, string>> = {
  [-3]: '#1f1636', [-2]: '#2b1f57', [-1]: '#33337a',
  1: '#22568f', 2: '#137a8f', 3: '#129a7d', 4: '#3db35a', 5: '#8cc437',
  6: '#d4c62a', 7: '#f2a81c', 8: '#f47b1a', 9: '#ec4f1e', 10: '#e0262b',
};
const MIN_FLOOR = -3, MAX_FLOOR = 10;

export function floorColor(floor: number) {
  const f = Math.max(MIN_FLOOR, Math.min(MAX_FLOOR, floor === 0 ? 1 : Math.round(floor)));
  return FLOOR_COLORS[f];
}
export const floorLabel = (floor: number) => (floor < 0 ? `B${-floor}` : `${floor}F`);

/**
 * Floor number written in a levelId: "B1" / "지하1" -> -1, "1F" / "2층" / "F3" / "L3" / "3" -> that floor,
 * "outdoor" / "ground" / "G" -> 1. Anything else (e.g. "북악관_Z146.18_추정") -> null.
 */
export function floorFromLevelId(levelId: string | null | undefined): number | null {
  if (!levelId) return null;
  const s = levelId.trim();
  if (/^(outdoor|ground|g|지상|실외)$/i.test(s)) return 1;
  let m = /(?:^|[^a-z0-9])b\s*(\d{1,2})(?![0-9])/i.exec(` ${s}`) ?? /지하\s*(\d{1,2})/.exec(s);
  if (m) return -Number(m[1]);
  m = /(\d{1,2})\s*(?:f|층)(?![a-z])/i.exec(s) ?? /^(?:f|l)\s*(\d{1,2})$/i.exec(s) ?? /^(\d{1,2})$/.exec(s);
  if (m) return Math.max(1, Number(m[1]));
  return null;
}

/** Floor from height above the ground (1F at the ground, one floor per floorHeightM). */
export function floorFromHeight(z: number, ground: number, floorHeightM: number) {
  const index = Math.round((z - ground) / Math.max(1, floorHeightM));
  return index >= 0 ? index + 1 : index;
}
