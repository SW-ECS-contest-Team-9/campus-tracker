// Collection anchors: markers that say where the collector really was (node, building, floor), the ground truth for
// training the on-device location correction and a height fix point for fusion (docs/API_CONTRACT.md "기준점").
// Everything here is pure; the repository and the session view feed it.

/** Building value for an anchor taken outside every building. */
export const OUTDOOR_BUILDING = 'outdoor';

/** Floor names: 1F, 2F, ... 15F above ground, B1, B2, ... below. No 0F, no "G". */
export const FLOOR_NAME = /^(?:B[1-9]|[1-9]\d?F)$/;

export const ANCHOR_TYPES = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  stairStart: 'stairStart',
  stairEnd: 'stairEnd',
  elevatorBoard: 'elevatorBoard',
  elevatorExit: 'elevatorExit',
  entrance: 'entrance',
  rampStart: 'rampStart',
  rampEnd: 'rampEnd',
} as const;

/** Floor number of a floor name (B1 -> -1, 3F -> 3), null when it is not one. */
export function floorNumber(name: string | null | undefined): number | null {
  if (!name || !FLOOR_NAME.test(name)) return null;
  return name.startsWith('B') ? -Number(name.slice(1)) : Number(name.slice(0, -1));
}

export const floorName = (n: number) => (n < 0 ? `B${-n}` : `${Math.max(1, n)}F`);

/**
 * The floor written in a road or node levelId, as a floor name: "B1" / "지하1" -> B1, "1F" / "2층" / "F3" / "L3" / "3" -> that
 * floor. Anything else (outdoor, "북악관_Z146.18_추정") -> null. Same reading as the editor's floorFromLevelId.
 */
export function floorFromLevelId(levelId: string | null | undefined): string | null {
  if (!levelId) return null;
  const s = levelId.trim();
  let m = /(?:^|[^a-z0-9])b\s*(\d{1,2})(?![0-9])/i.exec(` ${s}`) ?? /지하\s*(\d{1,2})/.exec(s);
  if (m) return Number(m[1]) > 0 ? `B${Number(m[1])}` : null;
  m = /(\d{1,2})\s*(?:f|층)(?![a-z])/i.exec(s) ?? /^(?:f|l)\s*(\d{1,2})$/i.exec(s) ?? /^(\d{1,2})$/.exec(s);
  if (m) return floorName(Math.max(1, Number(m[1])));
  return null;
}

export interface AnchorFields {
  type: string;
  timestamp: Date | string;
  nodeId: string | null;
  buildingId: string | null;
  floor: string | null;
  direction: string | null;
  fromFloor: string | null;
  toFloor: string | null;
}

export type AnchorProblem =
  | 'START_MISSING' | 'START_INCOMPLETE' | 'END_MISSING' | 'END_INCOMPLETE'
  | 'STAIR_UNPAIRED' | 'STAIR_INCOMPLETE' | 'ELEVATOR_UNPAIRED' | 'ELEVATOR_INCOMPLETE'
  | 'ENTRANCE_INCOMPLETE' | 'RAMP_INCOMPLETE';

export interface TrainingLabel {
  /** the session has the anchors the location-correction training needs (start, end, paired stairs/elevators) */
  valid: boolean;
  problems: AnchorProblem[];
  anchors: number;
  /** anchors that name a network node (a fix point for position and height) */
  nodeAnchors: number;
}

/** Where the collector stood: a building and its floor, or outside (the node is optional where a floor has none). */
const placed = (m: AnchorFields) => m.buildingId === OUTDOOR_BUILDING ? m.nodeId !== null : m.buildingId !== null && m.floor !== null;
const floorsGiven = (m: AnchorFields) => m.fromFloor !== null && m.toFloor !== null;
const directed = (m: AnchorFields) => m.direction === 'up' || m.direction === 'down';

/** Start/end pairs in time order: every start closed by the next end of its kind before another start. */
function paired(list: AnchorFields[], start: string, end: string) {
  let open = false;
  for (const m of list) {
    if (m.type === start) {
      if (open) return false;
      open = true;
    } else if (m.type === end) {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
}

/** Training label of one session from its markers (any order). Sessions of older apps simply come out invalid. */
export function trainingLabel(markers: AnchorFields[]): TrainingLabel {
  const list = [...markers].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const problems = new Set<AnchorProblem>();
  const starts = list.filter((m) => m.type === ANCHOR_TYPES.sessionStart);
  const ends = list.filter((m) => m.type === ANCHOR_TYPES.sessionEnd);
  if (!starts.length) problems.add('START_MISSING');
  else if (!placed(starts[0])) problems.add('START_INCOMPLETE');
  if (!ends.length) problems.add('END_MISSING');
  else if (!placed(ends.at(-1)!)) problems.add('END_INCOMPLETE');

  const stairs = list.filter((m) => m.type === ANCHOR_TYPES.stairStart || m.type === ANCHOR_TYPES.stairEnd);
  if (!paired(stairs, ANCHOR_TYPES.stairStart, ANCHOR_TYPES.stairEnd)) problems.add('STAIR_UNPAIRED');
  if (stairs.some((m) => !directed(m) || !floorsGiven(m))) problems.add('STAIR_INCOMPLETE');

  const lifts = list.filter((m) => m.type === ANCHOR_TYPES.elevatorBoard || m.type === ANCHOR_TYPES.elevatorExit);
  if (!paired(lifts, ANCHOR_TYPES.elevatorBoard, ANCHOR_TYPES.elevatorExit)) problems.add('ELEVATOR_UNPAIRED');
  if (lifts.some((m) => !floorsGiven(m))) problems.add('ELEVATOR_INCOMPLETE');

  // entrance and ramp markers of older apps carry none of these fields; only new (filled-in) ones are checked
  const anchored = (m: AnchorFields) => m.nodeId !== null || m.buildingId !== null || m.floor !== null || m.direction !== null;
  if (list.some((m) => m.type === ANCHOR_TYPES.entrance && anchored(m) && (m.buildingId === null || m.buildingId === OUTDOOR_BUILDING || m.floor === null))) {
    problems.add('ENTRANCE_INCOMPLETE');
  }
  if (list.some((m) => (m.type === ANCHOR_TYPES.rampStart || m.type === ANCHOR_TYPES.rampEnd) && anchored(m) && !directed(m))) problems.add('RAMP_INCOMPLETE');

  return {
    valid: problems.size === 0,
    problems: [...problems],
    anchors: list.filter((m) => anchored(m) || floorsGiven(m)).length,
    nodeAnchors: list.filter((m) => m.nodeId !== null).length,
  };
}
