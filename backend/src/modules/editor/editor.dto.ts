import { z } from 'zod';
import { Uuid } from '../../common/dto.js';

export const XYZ = z.tuple([
  z.number().finite().min(100_000).max(300_000),
  z.number().finite().min(450_000).max(650_000),
  z.number().finite().min(-100).max(2_000),
]);

const RoadFields = z.object({
  name: z.string().trim().max(160).nullish(),
  roadClass: z.enum(['pedestrian', 'vehicle', 'shared']),
  structure: z.enum(['ordinary', 'sidewalk', 'crossing', 'stairs', 'ramp', 'indoor_corridor', 'elevator']).default('ordinary'),
  pedestrianAccess: z.enum(['allowed', 'prohibited', 'restricted', 'unknown']).default('unknown'),
  vehicleAccess: z.enum(['allowed', 'prohibited', 'restricted', 'unknown']).default('unknown'),
  pedestrianDirection: z.enum(['both', 'forward', 'backward', 'unknown']).default('unknown'),
  vehicleDirection: z.enum(['both', 'forward', 'backward', 'unknown']).default('unknown'),
  widthM: z.number().positive().max(100).nullish(),
  wheelchairAccess: z.enum(['allowed', 'prohibited', 'restricted', 'unknown']).default('unknown'),
  buildingId: z.string().max(80).nullish(),
  levelId: z.string().max(80).nullish(),
});

export const BranchFrom = z.object({ roadId: Uuid, vertexIndex: z.number().int().nonnegative() });
export type BranchFrom = z.infer<typeof BranchFrom>;

/** Vertex `vertexIndex` of the saved line lies on `roadId` at XY distance `measureM` from its start: connect them there. */
export const Anchor = z.object({ roadId: Uuid, measureM: z.number().finite().nonnegative(), vertexIndex: z.number().int().nonnegative() });
export type Anchor = z.infer<typeof Anchor>;

export const RoadSave = RoadFields.extend({
  id: Uuid,
  coordinates: z.array(XYZ).min(2).max(20_000),
  expectedRevision: z.number().int().positive().nullish(),
  leaseToken: Uuid,
  sessionId: Uuid,
  branchFrom: BranchFrom.optional(),
  anchors: z.array(Anchor).max(50).default([]),
  /** Required lease tokens and revisions for all existing roads the topology operation may split. */
  affected: z.array(z.object({ id: Uuid, revision: z.number().int().positive(), leaseToken: Uuid, sessionId: Uuid })).max(500).default([]),
  mutationId: Uuid,
});
export type RoadSave = z.infer<typeof RoadSave>;

export const JunctionSave = z.object({
  coordinate: XYZ,
  roads: z.array(z.object({ id: Uuid, revision: z.number().int().positive(), leaseToken: Uuid })).min(2).max(32),
  sessionId: Uuid,
  mutationId: Uuid,
});
export type JunctionSave = z.infer<typeof JunctionSave>;

export const PlaceSave = z.object({
  id: Uuid,
  name: z.string().trim().min(1).max(160),
  category: z.enum(['building_entrance', 'destination', 'facility', 'landmark', 'parking', 'bus_stop', 'other']),
  description: z.string().max(2000).nullish(),
  buildingId: z.string().max(80).nullish(),
  levelId: z.string().max(80).nullish(),
  coordinate: XYZ,
  expectedRevision: z.number().int().positive().nullish(),
  leaseToken: Uuid,
  sessionId: Uuid,
  mutationId: Uuid,
});
export type PlaceSave = z.infer<typeof PlaceSave>;

export const LeaseRequest = z.object({
  objectType: z.enum(['road', 'place']),
  objectId: Uuid,
  sessionId: Uuid,
});
export type LeaseRequestData = z.infer<typeof LeaseRequest>;

export const LeaseRelease = z.object({
  objectType: z.enum(['road', 'place']),
  objectId: Uuid,
  sessionId: Uuid,
  leaseToken: Uuid,
});
export type LeaseReleaseData = z.infer<typeof LeaseRelease>;

export const EditorQuery = z.object({ status: z.enum(['DRAFT', 'APPROVED', 'all']).default('all') });

export type RoadFieldsType = z.infer<typeof RoadFields>;
