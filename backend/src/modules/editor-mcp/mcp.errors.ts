// Service errors -> tool error payloads. Every code carries what the model should do next.
import { toErrorBody } from '../../common/errors/app-error.js';
import { logger } from '../../common/logger.js';

const HINTS: Record<string, string> = {
  REVISION_CONFLICT: 'The object changed after you read it. Call get_feature again and retry with the current revision.',
  EDITOR_OBJECT_LOCKED: 'Another worker is editing this object. Tell the user who holds it, or retry after the lease expires.',
  EDITOR_LEASE_REQUIRED: 'The edit lease was lost mid-operation. Retry the tool call.',
  TOPOLOGY_REFRESH_REQUIRED: 'Roads near this change were modified concurrently. Re-read the affected roads and plan again.',
  OUTSIDE_TERRAIN: 'Coordinates must stay inside the terrain bounds from get_editor_context.',
  JUNCTION_UNAVAILABLE: 'Fewer than two unconnected roads meet here on one level. Use find_nearby to inspect the point.',
  SCOPE_REQUIRED: 'This token is read-only. The user can issue a write token with: npm run mcp:token -- --collector <ID> --agent <name> --scope write',
  APPROVED_PROTECTED: 'Tell the user: approved objects can only be changed by a person in the editor.',
  DUPLICATE_GEOMETRY: 'This road already exists (possibly from an earlier call whose answer was lost). Check details.roadId with get_feature.',
  LEVEL_MISMATCH: 'Set levelId to the level of the road you reference (see get_editor_context.levelIdsInUse), or reference a road on your level.',
  ANCHOR_MOVED: 'Call the tool again: the referenced road changed while the path was resolved.',
  ANCHOR_SOURCE_CHANGED: 'Re-read the referenced road with get_feature and build the path again.',
  REVERT_BLOCKED: 'Revert the later change sets listed in details first (newest first), or fix the objects by hand.',
  REVERT_UNSUPPORTED: 'This change predates before-images. Restore the objects manually with update_road / create_road.',
  NODE_COLLISION: 'Use connect_roads at the target instead of moving one node onto another.',
  MERGE_AT_JUNCTION: 'Roads can only be merged where exactly two roads meet.',
  MERGE_ATTRIBUTES_DIFFER: 'Make the attributes in details.differing equal with update_road first, or keep the roads separate.',
  RATE_LIMITED: 'Wait a minute, or combine changes with apply_changes.',
  CURSOR_UNAVAILABLE: 'Ask the person to click a location in the editor first, or use coordinates.',
  VALIDATION_ERROR: 'Fix the arguments listed in details and call again.',
};

export function toToolError(err: unknown, tool: string) {
  const { status, body } = toErrorBody(err);
  if (status >= 500) logger.error('mcp.tool_error', { tool, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  return { code: body.code, message: body.message, details: body.details, hint: HINTS[body.code] };
}
