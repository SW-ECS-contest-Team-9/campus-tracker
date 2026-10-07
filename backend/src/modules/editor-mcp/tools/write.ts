// Editing tools. Every one runs through agent-editor.execute: one transaction, DRAFT objects only, dryRun = real run + rollback.
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { LIMITS, OP_SCHEMAS, execute, type Op, type OpName } from '../agent-editor.js';
import { SCOPE_WRITE, defineTool, type ToolDef } from '../mcp.context.js';

const dryRun = z.boolean().default(false).describe('true = run the change for real and roll it back: returns exactly what would happen and shows it to people in the editor as a proposal');

const META: Record<OpName, { title: string; description: string; destructive?: boolean }> = {
  create_road: { title: 'Create a road',
    description: 'Draw a new DRAFT road centerline. path mixes free points {xy}, exact positions on existing objects {at}, and stretches of recorded '
      + 'tracks {run}/{canonical}. Reference roads with {at:{roadId,...}} wherever it must connect: coordinates typed by hand do not connect reliably. '
      + 'Access defaults follow roadClass (pedestrian: walking allowed, vehicles prohibited; vehicle: the reverse; shared: both). '
      + 'Crossing an existing road on the same level and height splits both and joins them at a node. '
      + 'An elevator is structure "elevator" with exactly two path points at the same x,y and different z (one road per pair of floors; zMode "explicit" or {at:{nodeId}} ends). '
      + 'Returns the saved pieces, crossings and whether each reference connected.' },
  update_road: { title: 'Change a road',
    description: 'Change attributes and/or geometry of a DRAFT road. Needs expectedRevision from get_feature/list_features. Geometry: replace it all with path, '
      + 'or edit vertices with vertexOps (move/insert/delete/replaceRange), reverse, simplifyM, drapeToTerrain. If the new shape crosses other roads it is replaced by new pieces with new ids.' },
  connect_roads: { title: 'Connect roads at a point',
    description: 'Make the roads that pass within 0.75 m of a point (same level, similar height) meet in one shared node: ends are snapped onto it, roads passing through are split. '
      + 'Use it for findings from validate_network. Fails if fewer than two unconnected roads are there.' },
  create_place: { title: 'Create a place', description: 'Add a DRAFT place marker (entrance, facility, landmark, ...) at a position. Placing it near a road does not connect it to the network.' },
  update_place: { title: 'Change a place', description: 'Change the attributes and/or position of a DRAFT place. Needs expectedRevision.' },
  retire_feature: { title: 'Retire a road or place', destructive: true,
    description: 'Remove a DRAFT road or place from the active network (status RETIRED; the row is kept and revert_changeset can restore it). Needs expectedRevision.' },
  move_node: { title: 'Move a junction',
    description: 'Move a network node together with the end of every road attached to it, so they stay connected. Use this instead of moving one road end with update_road.' },
  split_road: { title: 'Split a road',
    description: 'Cut one DRAFT road in two at a distance from its start (or at the point nearest to a location). Both pieces keep its attributes; use it before giving part of a road different attributes.' },
  merge_roads: { title: 'Merge two roads',
    description: 'Join two DRAFT roads that meet at a node no other road uses and that have the same attributes into one road.' },
  revert_changeset: { title: 'Undo a change set', destructive: true,
    description: 'Undo one earlier change set (id from get_changes or from a tool result) with a new change set: created objects are retired, replaced/retired ones restored, edited ones reset. '
      + 'Refused if those objects were changed again later. Revert a batch in reverse order of its change sets.' },
};

const single = (Object.keys(OP_SCHEMAS) as OpName[]).map((name) => defineTool({
  name, title: META[name].title, description: META[name].description,
  input: z.object({ ...(OP_SCHEMAS[name] as z.ZodObject).shape, dryRun }),
  scope: SCOPE_WRITE,
  annotations: { readOnlyHint: false, destructiveHint: !!META[name].destructive, idempotentHint: false },
  async run(input, ctx) {
    const { dryRun: dry, ...args } = input as { dryRun: boolean } & Record<string, unknown>;
    const out = await execute(ctx, [{ op: name, args }], dry);
    const { op: _op, ...result } = out.results[0] as Record<string, unknown>;
    return { dryRun: out.dryRun, ...(out.note ? { note: out.note } : {}), ...result };
  },
}));

const applyChanges = defineTool({
  name: 'apply_changes',
  title: 'Apply several changes atomically',
  description: `Run up to ${LIMITS.opsPerBatch} operations in order in ONE transaction: if any fails, nothing is saved. Each item is {op, args} with op one of `
    + `${Object.keys(OP_SCHEMAS).join(', ')} and args exactly as for that tool (without dryRun). Later items see the results of earlier ones, `
    + 'but ids created inside the batch are only known afterwards, so reference existing objects or coordinates. Use dryRun first for large batches.',
  input: z.object({
    ops: z.array(z.object({ op: z.enum(Object.keys(OP_SCHEMAS) as [OpName, ...OpName[]]), args: z.record(z.string(), z.unknown()) })).min(1).max(LIMITS.opsPerBatch),
    dryRun,
  }),
  scope: SCOPE_WRITE,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async run(input, ctx) {
    const ops: Op[] = input.ops.map((item, i) => {
      const parsed = (OP_SCHEMAS[item.op] as z.ZodType).safeParse(item.args);
      if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', `ops[${i}] (${item.op}): invalid args`, z.flattenError(parsed.error));
      return { op: item.op, args: parsed.data };
    });
    return execute(ctx, ops, input.dryRun);
  },
});

export const writeTools: ToolDef<any>[] = [...single, applyChanges];
