// POST /mcp — Streamable HTTP, stateless (docs/EDITOR_MCP_PLAN.md 3.2): a dev-server restart never breaks an AI conversation.
// The backend listens on the LAN for phones, so this route adds its own guards: loopback clients only (unless
// MCP_ALLOW_REMOTE), Host/Origin validation against DNS rebinding, and an agent token.
import { Router, type RequestHandler } from 'express';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { verifyAgentToken } from '../../common/auth/jwt.js';
import { logger } from '../../common/logger.js';
import { collectorService } from '../collectors/collector.service.js';
import { agentContext, createEditorMcpServer } from './mcp.server.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const loopbackOnly: RequestHandler = (req, _res, next) => {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) throw AppError.forbidden('MCP_LOCAL_ONLY', 'The MCP endpoint only accepts connections from this machine');
  next();
};

const agentAuth: RequestHandler = async (req, _res, next) => {
  const token = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw AppError.unauthorized('TOKEN_REQUIRED', 'Agent token required (npm run mcp:token)');
  const { identity, claims, expiresAt } = verifyAgentToken(token);
  await collectorService.touchDevice(identity); // deleting the device row revokes the token
  const auth: AuthInfo = { token, clientId: claims.agent, scopes: claims.scopes, expiresAt };
  (req as typeof req & { auth?: AuthInfo }).auth = auth;
  next();
};

const handler = toNodeHandler(
  createMcpHandler((ctx) => createEditorMcpServer(agentContext(ctx.authInfo)), {
    onerror: (err) => logger.warn('mcp.error', { message: err.message }),
  }),
);

export const mcpRoutes = Router();
if (!env.MCP_ALLOW_REMOTE) mcpRoutes.use(loopbackOnly, localhostHostValidation(), localhostOriginValidation());
mcpRoutes.use(agentAuth);
mcpRoutes.all('/', (req, res) => handler(req, res, req.body));
