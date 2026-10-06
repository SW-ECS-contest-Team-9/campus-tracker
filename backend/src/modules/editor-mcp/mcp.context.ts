// Transport-independent pieces of the editor MCP server (docs/EDITOR_MCP_PLAN.md). Tools are plain descriptors;
// only mcp.server.ts knows the SDK, so the SDK can be swapped without touching tool code.
import type { z } from 'zod';
import type { CollectorIdentity } from '../../common/auth/jwt.js';

export const SCOPE_READ = 'editor:read';
export const SCOPE_WRITE = 'editor:write';
export const SCOPE_APPROVED = 'editor:approved';

/** Who is calling: the collector account that issued the token, and the AI client acting for it. */
export interface AgentContext {
  identity: CollectorIdentity;
  /** Client label from the token, e.g. "claude-code". */
  agent: string;
  scopes: string[];
  /** Editor session id for leases. The token's device row id: stable across stateless requests, distinct from browser tabs. */
  sessionId: string;
}

export interface ToolDef<Schema extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: Schema;
  scope: typeof SCOPE_READ | typeof SCOPE_WRITE;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run(args: z.infer<Schema>, ctx: AgentContext): Promise<unknown>;
}

export const defineTool = <Schema extends z.ZodType>(tool: ToolDef<Schema>): ToolDef<Schema> => tool;
