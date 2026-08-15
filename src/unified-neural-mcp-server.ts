import express from 'express';
import { createHash, randomUUID as uuidv4 } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import cors from 'cors';
import helmet from 'helmet';
import { MemoryManager } from './unified-server/memory/index.js';
import { MessageHubIntegration } from './message-hub/hub-integration.js';
import { resolveMessageHubPort } from './message-hub/config.js';
import { UnifiedToolSchemas } from './shared/toolSchemas.js';
import { ENG4_TOOLS, RETAINED_LEGACY_TOOLS, handleEng4Tool, ENG4_RESOURCE_TEMPLATES, readEng4Resource } from './unified-server/eng4/register.js';
import { validateEng4Output } from './unified-server/eng4/register.js';
import { adaptLegacyBeginSessionArgs } from './unified-server/eng4/schemas.js';
import { performBeginSession, performEndSession } from './unified-server/eng4/session.js';
import {
  authMiddleware,
  rateLimitMiddleware,
  messageRateLimitMiddleware,
  validateBody,
  validateRawBody,
  getRateLimiterStatus,
  setTenantResolver,
  LocalTenantResolver,
  DEFAULT_REQUEST_CONTEXT,
  checkAuthConfigured,
} from './middleware/index.js';
import type { RequestContext } from './middleware/index.js';
import type { TenantRequest } from './middleware/index.js';
import { metrics, sloMonitor, recordMCPLatency, startSLOMonitoring, stopSLOMonitoring, correlationMiddleware, logger } from './observability/index.js';
import { NotificationPort, SlackNotificationAdapter } from './notifications/index.js';
import {
  AgentAuthorizationError,
  AgentCredentialStore,
  bindAgentInvocation,
  bindMessageResourceRecipient,
  assertAgentCredentialScope,
  createAgentCredentialMiddleware,
  resolveAgentAuthMode,
} from './agent-auth/index.js';
import type { AgentAuthMode } from './agent-auth/index.js';

const packageMetadata = createRequire(import.meta.url)('../package.json') as { version?: unknown };
if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0) {
  throw new Error('HYTHE package metadata does not contain a valid version');
}

/** The single source for every version advertised by the running server. */
export const HYTHE_VERSION = packageMetadata.version;
export const HYTHE_SERVICE_NAME = 'hythe';

// Unified Neural AI Collaboration MCP Server
// Exposes ALL system capabilities through a single MCP interface
export class NeuralMCPServer {
  private memoryManager: MemoryManager;
  private app!: express.Application;
  private agentId: string;
  private sessionId: string;
  private port: number;
  private messageHub?: MessageHubIntegration;
  private notificationPort: NotificationPort;
  private restoring = false;
  private httpServer?: HttpServer;
  private startPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private resourceShutdownPromise?: Promise<void>;
  private messageHubStarted = false;
  private lifecycleState: 'initialized' | 'starting' | 'ready' | 'closing' | 'closed' = 'initialized';
  private agentCredentialStore: AgentCredentialStore;
  private agentAuthMode: AgentAuthMode;

  constructor(port: number = 6174, dbPath?: string) {
    this.port = port;
    this.memoryManager = new MemoryManager(dbPath);
    this.agentCredentialStore = new AgentCredentialStore(this.memoryManager.getDb());
    this.agentAuthMode = resolveAgentAuthMode();
    this.agentId = 'unified-neural-mcp-server';
    this.sessionId = 'neural-unified-session';
    
    this.notificationPort = new SlackNotificationAdapter();

    // Initialize tenant resolver with DB reference for JWT auth
    const resolver = new LocalTenantResolver(
      this.memoryManager.getDb(),
      process.env.AUTH0_CLAIMS_NAMESPACE || 'https://neural-mcp.local/'
    );
    setTenantResolver(resolver);

    this.setupExpressServer();
    this.registerWithUnifiedServer();
    this.initializeMessageHub();
  }

  private async initializeMessageHub() {
    try {
      const hubPort = resolveMessageHubPort();
      this.messageHub = new MessageHubIntegration(
        hubPort,
        this.port,
        this.agentCredentialStore,
        this.agentAuthMode,
      );
      
      console.log(`🔗 Message Hub integration initialized on port ${hubPort}`);
    } catch (error) {
      console.error('❌ Failed to initialize Message Hub:', error);
    }
  }

  private setupExpressServer() {
    this.app = express();

    // Correlation ID middleware (first to capture all requests)
    this.app.use(correlationMiddleware);

    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: false, // Disable CSP for API server
      crossOriginEmbedderPolicy: false
    }));

    // CORS: closed-safe by default (Phase-1 config hardening) — with
    // CORS_ORIGINS unset, NO cross-origin browser access is granted. The
    // stdio bridge, curl and other non-browser clients send no Origin header
    // and are unaffected. Opt in with a comma-separated allowlist ('*' is an
    // explicit choice, never the default).
    const corsOrigins = (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (corsOrigins.length > 0) {
      this.app.use(cors({
        origin: corsOrigins.includes('*') ? true : corsOrigins,
      }));
    }

    // Raw body parser for /ai-message (before JSON parser)
    // Limit aligned with validateRawBody MAX_RAW_BODY_SIZE (1MB)
    this.app.use('/ai-message', express.raw({ type: '*/*', limit: '1mb' }));

    // JSON body parser for other routes
    this.app.use((req, res, next) => {
      if (req.path === '/ai-message') {
        return next();
      }
      if (req.path === '/api/data/import') {
        express.json({ limit: '50mb' })(req, res, next);
        return;
      }
      express.json({ limit: '10mb' })(req, res, next);
    });

    // ============================================================================
    // SECURITY MIDDLEWARE - Phase 1 Implementation
    // ============================================================================

    // Apply authentication to all routes except public paths
    this.app.use(authMiddleware);

    // Independent per-agent proof. The existing key/JWT remains the tenant or
    // deployment credential; an agent credential can only narrow and bind it.
    this.app.use(createAgentCredentialMiddleware(this.agentCredentialStore, this.agentAuthMode));

    // Apply general rate limiting
    this.app.use(rateLimitMiddleware);

    // A supplied per-agent proof always narrows the deployment/JWT authority.
    // Operator routes that do not naturally flow through the MCP binder must
    // opt into an explicit agent-side scope before reading or mutating state.
    const requireAgentScope = (
      req: express.Request,
      res: express.Response,
      scope: string,
    ): boolean => {
      const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
      try {
        assertAgentCredentialScope(context, scope);
        return true;
      } catch (error) {
        if (error instanceof AgentAuthorizationError) {
          res.status(error.status).json({
            error: 'Agent authorization failed',
            code: error.code,
          });
          return false;
        }
        throw error;
      }
    };

    // Restore locking: reject requests during DB restore
    this.app.use((req, res, next) => {
      if (this.restoring && !req.path.startsWith('/health')) {
        res.status(503).json({ error: 'Service temporarily unavailable during database restore' });
        return;
      }
      next();
    });

    // Apply stricter rate limiting and validation to message endpoints
    this.app.use('/ai-message', messageRateLimitMiddleware);
    this.app.post('/ai-message', validateRawBody('aiMessage'));

    // Apply validation to tool calls
    this.app.post('/api/tools/:toolName', validateBody('toolCall'));

    // Apply validation to MCP endpoint
    this.app.post('/mcp', validateBody('mcpRequest'));

    // Health check endpoint (liveness probe)
    this.app.get('/health', (_req, res) => {
      const rateLimiterStatus = getRateLimiterStatus();
      res.json({
        status: 'healthy',
        service: HYTHE_SERVICE_NAME,
        version: HYTHE_VERSION,
        lifecycle: this.lifecycleState,
        agentAuthMode: this.agentAuthMode,
        timestamp: new Date().toISOString(),
        port: this.port,
        agentId: this.agentId,
        rateLimiter: rateLimiterStatus,
        capabilities: [
          'advanced-memory-systems',
          'multi-provider-ai',
          'autonomous-agents',
          'real-time-collaboration',
          'cross-platform-support',
          'consensus-coordination',
          'ml-integration',
          'event-driven-orchestration'
        ]
      });
    });

    // Readiness probe - checks advanced system connectivity
    this.app.get('/ready', async (_req, res) => {
      try {
        const systemStatus = await this.memoryManager.getSystemStatus();
        const activeAlerts = sloMonitor.getActiveAlerts();
        const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical');

        // Determine readiness based on system connectivity
        const lifecycleReady = this.lifecycleState === 'ready';
        const isReady = lifecycleReady && systemStatus.sqlite.connected; // SQLite is minimum requirement
        const vectorConnected = systemStatus.vector?.connected ?? systemStatus.weaviate?.connected ?? false;
        const isDegraded = !isReady
          || !systemStatus.advancedSystemsEnabled
          || !vectorConnected
          || criticalAlerts.length > 0;

        const status = {
          ready: isReady,
          degraded: isDegraded,
          version: HYTHE_VERSION,
          lifecycle: this.lifecycleState,
          agentAuthMode: this.agentAuthMode,
          systems: {
            sqlite: systemStatus.sqlite.connected,
            vector: vectorConnected,
            weaviate: systemStatus.weaviate?.connected ?? vectorConnected, // legacy alias
            advancedSystemsEnabled: systemStatus.advancedSystemsEnabled
          },
          criticalAlerts: criticalAlerts.length,
          timestamp: new Date().toISOString()
        };

        // Return 200 if fully ready, 207 if degraded, 503 if down
        if (isReady && !isDegraded) {
          res.status(200).json(status);
        } else if (isReady && isDegraded) {
          res.status(207).json(status);
        } else {
          res.status(503).json(status);
        }
      } catch (error) {
        res.status(503).json({
          ready: false,
          degraded: true,
          version: HYTHE_VERSION,
          lifecycle: this.lifecycleState,
          agentAuthMode: this.agentAuthMode,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Secret-free identity attestation for clients. This route never accepts
    // a caller-supplied agent id: the response is derived exclusively from
    // the independently validated agent credential in RequestContext.
    this.app.get('/agent/whoami', (req, res) => {
      const context = (req as TenantRequest).requestContext;
      if (!context?.agentPrincipal) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'A valid agent credential is required',
          code: 'AGENT_CREDENTIAL_REQUIRED',
        });
        return;
      }
      // Promotion evidence is intentionally route-specific: generic token
      // validation, denied requests, and malformed operations never qualify.
      this.agentCredentialStore.markCredentialAttested(
        context.agentPrincipal.credentialId,
        context.agentAuthMode,
      );
      res.json({
        tenantId: context.tenantId,
        agentId: context.agentPrincipal.agentId,
        credentialId: context.agentPrincipal.credentialId,
        scopes: [...context.agentPrincipal.scopes],
        enforcementState: context.agentPrincipal.enforcementState,
        authMode: context.agentAuthMode,
        version: HYTHE_VERSION,
      });
    });

    // Metrics endpoint (Prometheus-compatible)
    this.app.get('/metrics', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(metrics.toPrometheusFormat());
    });

    // Metrics JSON endpoint (for dashboards)
    this.app.get('/metrics.json', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      res.json(metrics.getSnapshot());
    });

    // Recent events endpoint (for debugging/alerting)
    this.app.get('/metrics/events', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      const count = parseInt(req.query.count as string) || 100;
      const category = req.query.category as string;
      const level = req.query.level as string;
      res.json(metrics.getRecentEvents(count, category, level));
    });

    // Event retention/compaction status endpoint
    this.app.get('/metrics/retention', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      res.json({
        config: metrics.getRetentionConfig(),
        compactionStats: metrics.getCompactionStats(),
        currentEventCount: metrics.getEventLogSize(),
        eventCountsByCategory: metrics.getEventCounts(),
        timestamp: new Date().toISOString()
      });
    });

    // Manual compaction trigger endpoint (POST)
    this.app.post('/metrics/compact', async (req, res) => {
      if (!requireAgentScope(req, res, 'ops:write')) return;
      try {
        const stats = await metrics.runCompaction();
        res.json({
          status: 'ok',
          compactionStats: stats,
          currentEventCount: metrics.getEventLogSize(),
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // SLO status endpoint
    this.app.get('/slo/status', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      res.json({
        status: sloMonitor.getSLOStatus(),
        activeAlerts: sloMonitor.getActiveAlerts(),
        timestamp: new Date().toISOString()
      });
    });

    // SLO alerts endpoint
    this.app.get('/slo/alerts', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      const limit = parseInt(req.query.limit as string) || 100;
      const activeOnly = req.query.active === 'true';

      if (activeOnly) {
        res.json(sloMonitor.getActiveAlerts());
      } else {
        res.json(sloMonitor.getAlertHistory(limit));
      }
    });

    // Logger configuration endpoint
    this.app.get('/logs/config', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:read')) return;
      res.json({
        config: logger.getConfig(),
        timestamp: new Date().toISOString()
      });
    });

    // Update logger configuration (POST)
    this.app.post('/logs/config', (req, res) => {
      if (!requireAgentScope(req, res, 'ops:write')) return;
      try {
        const newConfig = req.body;
        logger.configure(newConfig);
        res.json({
          status: 'ok',
          config: logger.getConfig(),
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(400).json({
          status: 'error',
          error: error instanceof Error ? error.message : 'Invalid configuration'
        });
      }
    });

    // Admin endpoint: query audit log (restricted unless ENABLE_ADMIN_ENDPOINTS is set)
    this.app.get('/admin/audit-log', (req, res): void => {
      if (!requireAgentScope(req, res, 'audit:read')) return;
      if (process.env.ENABLE_ADMIN_ENDPOINTS !== '1') {
        res.status(403).json({ error: 'Admin endpoints disabled. Set ENABLE_ADMIN_ENDPOINTS=1 to enable.' });
        return;
      }
      try {
        const { agent_id, operation, limit } = req.query as {
          agent_id?: string; operation?: string; limit?: string;
        };
        const entries = this.memoryManager.queryAuditLog(
          agent_id, operation, limit ? parseInt(limit, 10) : 20
        );
        res.json({ entries });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Direct HTTP API endpoints for all MCP tools
    this.app.get('/api/tools', async (_req, res) => {
      try {
        const tools = await this._handleToolsList();
        res.json(tools);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    this.app.post('/api/tools/:toolName', async (req, res) => {
      try {
        const { toolName } = req.params;
        const args = req.body;
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const result = await this._handleToolCall(toolName, args, context);
        res.json(result);
      } catch (error) {
        if (error instanceof AgentAuthorizationError) {
          res.status(error.status).json({
            error: 'Agent authorization failed',
            code: error.code,
          });
          return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Main MCP over HTTP endpoint - JSON-RPC over HTTP
    this.app.post('/mcp', async (req, res) => {
      const startTime = Date.now();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');

      try {
        // Request arguments can contain private messages, search terms, credentials,
        // and checkpoint state. Never serialize the MCP body into application logs.
        console.log('🔗 Unified Neural MCP request received');
        
        const { jsonrpc = '2.0', id, method, params = {} } = req.body || {};
        const defaultProtocolVersion = '2024-11-05';
        const requestedProtocolVersion = (params && typeof params === 'object' ? (params as any)?.protocolVersion : undefined)
          ?? (req.body?.protocolVersion)
          ?? defaultProtocolVersion;
        let result;
        
        if (!method) {
          console.log('🤝 MCP Initialization handshake');
          return res.json({
            jsonrpc: '2.0',
            id: id ?? 1,
            result: {
              protocolVersion: requestedProtocolVersion,
              capabilities: {
                tools: {},
                prompts: {},
                resources: {}
              },
              serverInfo: {
                name: HYTHE_SERVICE_NAME,
                version: HYTHE_VERSION
              }
            }
          });
        }

        const mcpContext = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        switch (method) {
          case 'initialize':
            result = {
              protocolVersion: requestedProtocolVersion,
              capabilities: {
                tools: {},
                prompts: {},
                resources: {}
              },
              serverInfo: {
                name: HYTHE_SERVICE_NAME,
                version: HYTHE_VERSION
              }
            };
            break;
            
          case 'tools/list':
            result = await this._handleToolsList();
            break;
            
          case 'tools/call': {
            result = await this._handleToolCall(params.name, params.arguments, mcpContext);
            break;
          }

          case 'resources/list':
            result = { resources: [] };
            break;

          case 'resources/templates/list':
            result = {
              resourceTemplates: ENG4_RESOURCE_TEMPLATES.map((template) => ({ ...template })),
            };
            break;

          case 'resources/read':
            result = this._handleResourceRead(String(params.uri ?? ''), mcpContext);
            break;
            
          default:
            return res.json({
              jsonrpc: '2.0',
              id: id ?? 1,
              error: {
                code: -32601,
                message: `Method not found: ${method}`
              }
            });
        }
        
        const latencyMs = Date.now() - startTime;
        recordMCPLatency(latencyMs);
        console.log(`✅ Unified Neural MCP request processed (${latencyMs}ms)`);
        return res.json({
          jsonrpc: '2.0',
          id: id ?? 1,
          result
        });

      } catch (error) {
        const latencyMs = Date.now() - startTime;
        recordMCPLatency(latencyMs);
        if (error instanceof AgentAuthorizationError) {
          console.warn(`⚠️ MCP agent authorization denied: ${error.code}`);
          return res.json({
            jsonrpc: '2.0',
            id: req.body?.id || 1,
            error: {
              code: -32003,
              message: 'Agent authorization failed',
              data: { code: error.code },
            },
          });
        }
        console.error(`❌ Unified Neural MCP request error (${latencyMs}ms):`, error);
        return res.json({
          jsonrpc: '2.0',
          id: req.body?.id || 1,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error'
          }
        });
      }
    });

    // AI-to-AI messaging endpoint
    this.app.post('/ai-message', async (req: any, res) => {
      try {
        let parsedData: any;
        
        if (Buffer.isBuffer(req.body)) {
          const rawString = req.body.toString('utf8');
          try {
            parsedData = JSON.parse(rawString);
          } catch (parseError: any) {
            let cleanedString = rawString.replace(/[^\x20-\x7E\n\r\t]/g, '');
            try {
              parsedData = JSON.parse(cleanedString);
            } catch (secondParseError: any) {
              const fromMatch = rawString.match(/"from"\s*:\s*"([^"]+)"/);
              const toMatch = rawString.match(/"to"\s*:\s*"([^"]+)"/);
              const messageMatch = rawString.match(/"(?:message|content)"\s*:\s*"([^"]+)"/);
              
              parsedData = {
                from: fromMatch?.[1] || 'unknown',
                to: toMatch?.[1] || 'unknown',
                message: messageMatch?.[1] || 'Failed to parse message content',
                content: messageMatch?.[1] || 'Failed to parse message content'
              };
            }
          }
        } else if (typeof req.body === 'string') {
          try {
            parsedData = JSON.parse(req.body);
          } catch (parseError: any) {
            parsedData = { from: 'unknown', to: 'unknown', message: req.body, content: req.body };
          }
        } else if (typeof req.body === 'object' && req.body !== null) {
          parsedData = req.body;
        } else {
          parsedData = { from: 'unknown', to: 'unknown', message: 'Unknown body type', content: 'Unknown body type' };
        }
        
        const { to, message, messageType: requestedMessageType, type, priority, content } = parsedData;
        const actualMessage = message || content || parsedData.payload?.message || parsedData.payload?.content;
        const reqContext = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const boundMessageArgs = bindAgentInvocation(
          'send_ai_message',
          parsedData,
          reqContext,
          this.agentCredentialStore,
        );
        const from = boundMessageArgs.from as string;

        if (!to || typeof to !== 'string' || !to.trim()) {
          res.status(400).json({ error: 'Message recipient is required' });
          return;
        }
        if (!actualMessage || typeof actualMessage !== 'string') {
          res.status(400).json({ error: 'Message content is required' });
          return;
        }
        const allowedMessageTypes = new Set([
          'direct', 'info', 'task', 'query', 'response', 'collaboration',
        ]);
        const messageType = requestedMessageType ?? type ?? 'direct';
        if (typeof messageType !== 'string' || !allowedMessageTypes.has(messageType)) {
          res.status(400).json({ error: 'Invalid message type' });
          return;
        }
        const messagePriority = priority ?? 'normal';
        if (!['low', 'normal', 'high', 'urgent'].includes(messagePriority)) {
          res.status(400).json({ error: 'Invalid message priority' });
          return;
        }

        const requestedSender = from;
        const senderAgentId = this.memoryManager.resolveMailboxAddress(requestedSender, reqContext.tenantId);
        const targetAgentId = this.memoryManager.resolveMailboxAddress(to, reqContext.tenantId);
        if (!senderAgentId || !targetAgentId) {
          res.status(400).json({ error: 'Message sender and recipient must be valid agent identifiers' });
          return;
        }
        console.log(
          `💬 AI Message: ${senderAgentId} → ${targetAgentId} `
          + `[${messageType}, ${actualMessage.length} chars]`
        );

        const messageId = await this.memoryManager.storeMessage(
          senderAgentId,
          targetAgentId,
          actualMessage,
          messageType,
          messagePriority,
          {
            original: {
              requestedFrom: requestedSender,
              requestedTo: to,
            },
          },
          reqContext.tenantId,
          reqContext
        );

        await this.publishEventToUnified('ai.message', {
          from: senderAgentId,
          to: targetAgentId,
          type: messageType,
          messageId: messageId,
          contentLength: actualMessage.length,
        });

        res.json({
          status: 'queued',
          messageId: messageId,
          deliveryStatus: 'queued',
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        if (error instanceof AgentAuthorizationError) {
          res.status(error.status).json({ error: 'Agent authorization failed', code: error.code });
          return;
        }
        console.error('❌ AI message error:', error);
        res.status(500).json({ error: 'Message delivery failed' });
      }
    });

    // Get messages for an AI agent — P1: uses indexed ai_messages table
    this.app.get('/ai-messages/:agentId', async (req, res) => {
      try {
        const { agentId: requestedAgentId } = req.params;
        const { since, messageType, limit, unreadOnly, markAsRead, from } = req.query as {
          since?: string; messageType?: string; limit?: string;
          unreadOnly?: string; markAsRead?: string; from?: string;
        };

        const msgReqContext = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const boundMailboxArgs = bindAgentInvocation(
          'get_ai_messages',
          { agentId: requestedAgentId },
          msgReqContext,
          this.agentCredentialStore,
        );
        const agentId = boundMailboxArgs.agentId as string;
        if (this.memoryManager.resolveMailboxAddress(agentId, msgReqContext.tenantId) !== agentId) {
          res.status(400).json({ error: 'Agent identity is invalid' });
          return;
        }
        if (from && this.memoryManager.resolveMailboxAddress(from, msgReqContext.tenantId) !== from) {
          res.status(400).json({ error: 'Sender filter identity is invalid' });
          return;
        }
        const rawMessages = this.memoryManager.getMessages(agentId, {
          messageType,
          since,
          limit: limit ? Math.max(1, Math.min(parseInt(limit, 10), 20)) : 5,
          unreadOnly: unreadOnly === 'true',
          markAsRead: markAsRead === 'true',
          tenantId: msgReqContext.tenantId,
          compact: false, // HTTP route always returns full content
          from,
        });

        const messages = rawMessages.map((msg: any) => {
          const meta = msg.metadata ? (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) : {};
          return {
          id: msg.id,
          content: {
            from: msg.from_agent,
            to: msg.to_agent,
            content: msg.content,
            messageType: msg.message_type,
            priority: msg.priority,
            timestamp: msg.created_at,
            deliveryStatus: this.messageDeliveryStatus(msg, meta),
          },
          timestamp: msg.created_at,
          from: msg.from_agent,
        };
        });

        res.json({ agentId, messages });
      } catch (error) {
        if (error instanceof AgentAuthorizationError) {
          res.status(error.status).json({ error: 'Agent authorization failed', code: error.code });
          return;
        }
        console.error('❌ Get messages error:', error);
        res.status(500).json({ error: 'Failed to get messages' });
      }
    });

    // ─── BV-S1: Graph Export API ───
    // ETag cache: Map<cacheKey, { etag, expiry }>
    const etagCache = new Map<string, { etag: string; expiry: number }>();
    const ETAG_TTL_MS = 30_000; // 30 seconds

    this.app.get('/api/graph-export', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;

        // A supplied agent proof narrows the base credential. Shared-key/JWT
        // operator calls may omit agent proof, but an agent-scoped call must
        // explicitly carry memory read authority.
        assertAgentCredentialScope(context, 'memory:read');

        // Authorize: must have graph:view at minimum
        const authResult = this.memoryManager.authorizeGraphRead(context);
        if (!authResult.authorized) {
          res.status(403).json({ error: 'Forbidden', message: authResult.reason });
          return;
        }

        const permissions = authResult.permissions;

        // Parse query params
        const cursor = req.query.cursor as string | undefined;
        const rawLimit = parseInt(req.query.limit as string, 10) || 200;
        const limit = Math.min(Math.max(rawLimit, 1), 1000); // clamp 1..1000
        const includeObservations = req.query.includeObservations === 'true';
        const updatedSince = req.query.updatedSince as string | undefined;
        const entityName = req.query.entityName as string | undefined;

        // Strict 403: observations requested without graph:observations:view
        // Applies to both includeObservations=true AND entityName mode (which always returns observations)
        const needsObservationPerm = includeObservations || !!entityName;
        if (needsObservationPerm && !permissions.has('graph:observations:view')) {
          res.status(403).json({
            error: 'Forbidden',
            message: 'graph:observations:view permission required for observation access',
          });
          return;
        }

        // Audit log
        this.memoryManager.auditLog(
          'graph_export',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ includeObservations, entityName, limit, cursor: cursor || null }),
          entityName
        );

        // Fetch data
        const data = this.memoryManager.getGraphExport({
          tenantId: context.tenantId,
          limit,
          cursor,
          includeObservations,
          updatedSince,
          entityName,
          permissions,
        });

        // Build response
        const generatedAt = new Date().toISOString();
        let responseBody: any;

        if (entityName) {
          // entityName mode: observations-only
          responseBody = {
            observations: data.observations || [],
            totals: { observations: data.totals.observations },
            generatedAt,
          };
          if (data.nextCursor) responseBody.nextCursor = data.nextCursor;
        } else {
          // Full mode
          responseBody = {
            nodes: data.nodes || [],
            links: data.links || [],
            nextCursor: data.nextCursor,
            totals: data.totals,
            generatedAt,
          };
          if (includeObservations) {
            responseBody.observations = data.observations || [];
          }
        }

        // Compute ETag: SHA-256 of canonical data + policy fingerprint
        const permSorted = Array.from(permissions).sort().join(',');
        const canonicalParts: string[] = [];
        if (responseBody.nodes) {
          for (const n of responseBody.nodes) {
            canonicalParts.push(`n:${n.name}:${n.entityType}:${n.observationCount}`);
          }
        }
        if (responseBody.links) {
          for (const l of responseBody.links) {
            canonicalParts.push(`l:${l.source}:${l.target}:${l.relationType}`);
          }
        }
        if (responseBody.observations) {
          for (const o of responseBody.observations) {
            canonicalParts.push(`o:${o.entityName}:${JSON.stringify(o.contents)}`);
          }
        }
        if (data.maxUpdatedAt) {
          canonicalParts.push(`upd:${data.maxUpdatedAt}`);
        }
        canonicalParts.push(`perms:${permSorted}`);

        const hashInput = canonicalParts.join('|');
        const now = Date.now();

        // Check ETag cache
        let etag: string;
        const cacheKey = hashInput;
        const cached = etagCache.get(cacheKey);
        if (cached && cached.expiry > now) {
          etag = cached.etag;
        } else {
          etag = `"${createHash('sha256').update(hashInput).digest('hex').slice(0, 32)}"`;
          etagCache.set(cacheKey, { etag, expiry: now + ETAG_TTL_MS });
        }

        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=30');

        // Honor If-None-Match
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === etag) {
          res.status(304).end();
          return;
        }

        res.json(responseBody);
      } catch (error) {
        if (error instanceof AgentAuthorizationError) {
          res.status(error.status).json({
            error: 'Agent authorization failed',
            code: error.code,
          });
          return;
        }
        console.error('graph-export error:', error);
        res.status(500).json({ error: 'Graph export failed' });
      }
    });

    // ─── Data Management API ─────────────────────────────────────
    // Feature gate: these endpoints are disabled unless ENABLE_DATA_MANAGEMENT=1,
    // and then require data:read (GET) or data:write (mutating) scope — or
    // admin/owner (JWT), or the local single-key operator. This single gate
    // replaces the per-endpoint authorizeGraphRead checks, which let destructive
    // ops (import / snapshots / restore) through on a read-level check and left
    // several snapshot/backup endpoints with no scope check at all.
    const isDataManagementEnabled = () => process.env.ENABLE_DATA_MANAGEMENT === '1';
    const authorizeDataManagement = (
      context: RequestContext,
      access: 'read' | 'write'
    ): { authorized: boolean; reason?: string } => {
      if (context.authType === 'dev') return { authorized: true };
      if (context.authType === 'jwt') {
        if (context.roles.includes('admin') || context.roles.includes('owner')) return { authorized: true };
        return { authorized: false, reason: 'Data management requires admin or owner role' };
      }
      if (context.authType === 'api_key') {
        const scopes = context.scopes || [];
        const hasAdminScope = scopes.includes('*') || scopes.includes('data:admin');
        const hasRequestedScope = access === 'read'
          ? scopes.includes('data:read') || scopes.includes('data:write')
          : scopes.includes('data:write');
        if (hasAdminScope || hasRequestedScope) return { authorized: true };
        // Local single API_KEY path: no persisted apiKeyId/scopes — allowed only
        // because the operator explicitly enabled this surface via env.
        if (!context.apiKeyId && scopes.length === 0) return { authorized: true };
        return { authorized: false, reason: `Data management requires data:${access} scope` };
      }
      return { authorized: false, reason: 'Unknown auth type' };
    };
    this.app.use('/api/data', (req, res, next) => {
      if (!isDataManagementEnabled()) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Data management endpoints are disabled. Set ENABLE_DATA_MANAGEMENT=1 to enable.',
          code: 'DATA_MANAGEMENT_DISABLED',
        });
        return;
      }
      const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
      const access: 'read' | 'write' = req.method === 'GET' ? 'read' : 'write';
      if (context.agentAuthMode === 'required' && context.agentPrincipal == null) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'An agent credential is required for data management in required mode',
          code: 'AGENT_CREDENTIAL_REQUIRED',
        });
        return;
      }
      if (context.agentPrincipal != null) {
        const agentScopes = context.agentPrincipal.scopes;
        const required = `data:${access}`;
        const hasAgentScope = agentScopes.includes('*')
          || agentScopes.includes('data:*')
          || agentScopes.includes('data:admin')
          || agentScopes.includes(required)
          || (access === 'read' && agentScopes.includes('data:write'));
        if (!hasAgentScope) {
          res.status(403).json({
            error: 'Forbidden',
            message: `Agent credential lacks required scope ${required}`,
            code: 'AGENT_SCOPE_REQUIRED',
          });
          return;
        }
      }
      const verdict = authorizeDataManagement(context, access);
      if (!verdict.authorized) {
        res.status(403).json({ error: 'Forbidden', message: verdict.reason, code: 'DATA_MANAGEMENT_FORBIDDEN' });
        return;
      }
      next();
    });

    this.app.get('/api/data/entity-prefixes', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const prefixes = this.memoryManager.listEntityPrefixes(context.tenantId);
        res.json({ prefixes });
      } catch (error: any) {
        console.error('❌ Entity prefixes error:', error);
        res.status(500).json({ error: error.message || 'Failed to list entity prefixes' });
      }
    });

    this.app.get('/api/data/export', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const namePrefix = req.query.namePrefix as string | undefined;
        const entityNamesRaw = req.query.entityNames as string | undefined;
        const entityNames = entityNamesRaw ? entityNamesRaw.split(',').map(n => n.trim()) : undefined;
        const preview = req.query.preview === 'true';

        this.memoryManager.auditLog(
          'data_export',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ namePrefix, entityNames, preview })
        );

        const backup = this.memoryManager.exportEntities({
          tenantId: context.tenantId,
          namePrefix,
          entityNames,
        });

        if (preview) {
          // Return counts + entity names only
          const entityNameList = (backup.entities || []).map((e: any) => {
            try { return JSON.parse(e.content).name; } catch { return null; }
          }).filter(Boolean);
          res.json({
            namePrefix,
            entityNames: entityNameList,
            counts: backup.counts,
          });
          return;
        }

        res.json(backup);
      } catch (error: any) {
        console.error('❌ Data export error:', error);
        res.status(500).json({ error: error.message || 'Failed to export data' });
      }
    });

    this.app.post('/api/data/import', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const backup = req.body;
        if (!backup || !backup.schemaVersion) {
          res.status(400).json({ error: 'Invalid backup payload: missing schemaVersion' });
          return;
        }

        this.memoryManager.auditLog(
          'data_import',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ schemaVersion: backup.schemaVersion, counts: backup.counts })
        );

        const result = await this.memoryManager.importEntities(backup, context.tenantId);
        res.json(result);
      } catch (error: any) {
        console.error('❌ Data import error:', error);
        res.status(500).json({ error: error.message || 'Failed to import data' });
      }
    });

    this.app.delete('/api/data/retire', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const { entityNames, reason } = req.body;
        if (!entityNames || !Array.isArray(entityNames) || entityNames.length === 0) {
          res.status(400).json({ error: 'entityNames array is required' });
          return;
        }

        // Atomic: writes a verified server-side trash entry BEFORE hard-deleting
        // (Phase 2b durable Trash). If the trash write fails, the whole op rolls
        // back — there is no delete without a persisted backup.
        const result = await this.memoryManager.retireEntitiesToTrash(
          entityNames,
          context.tenantId,
          reason
        );

        // Audit links the trashId (entity_name) so retire/restore/purge are traceable.
        this.memoryManager.auditLog(
          'data_retire',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ trashId: result.trashId, entityNames, counts: result.counts, reason }),
          result.trashId
        );

        res.json(result);
      } catch (error: any) {
        console.error('❌ Data retire error:', error);
        const code = /no matching entities/i.test(error?.message || '') ? 404 : 500;
        res.status(code).json({ error: error.message || 'Failed to retire entities' });
      }
    });

    this.app.get('/api/data/trash', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const trash = this.memoryManager.listTrash(context.tenantId);
        res.json({ trash });
      } catch (error: any) {
        console.error('❌ Trash list error:', error);
        res.status(500).json({ error: error.message || 'Failed to list trash' });
      }
    });

    this.app.post('/api/data/trash/:id/restore', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const result = await this.memoryManager.restoreFromTrash(req.params.id, context.tenantId);
        this.memoryManager.auditLog(
          'trash_restore',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ trashId: req.params.id, restored: result.restored }),
          req.params.id
        );
        res.json(result);
      } catch (error: any) {
        console.error('❌ Trash restore error:', error);
        const code = /not found/i.test(error?.message || '') ? 404 : 500;
        res.status(code).json({ error: error.message || 'Failed to restore from trash' });
      }
    });

    this.app.delete('/api/data/trash/:id', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const result = this.memoryManager.purgeTrash(req.params.id, context.tenantId);
        if (result.purged === 0) {
          // Unknown target — a no-op; do NOT write a success audit.
          res.status(404).json({ error: `Trash entry not found: ${req.params.id}` });
          return;
        }
        this.memoryManager.auditLog(
          'trash_purge',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ trashId: req.params.id }),
          req.params.id
        );
        res.json(result);
      } catch (error: any) {
        console.error('❌ Trash purge error:', error);
        res.status(500).json({ error: error.message || 'Failed to purge trash' });
      }
    });

    this.app.get('/api/data/backup-locations', async (_req, res) => {
      try {
        const locations = this.memoryManager.getBackupLocations();
        res.json({ locations });
      } catch (error: any) {
        console.error('❌ Backup locations error:', error);
        res.status(500).json({ error: error.message || 'Failed to list backup locations' });
      }
    });

    this.app.get('/api/data/backup-folders', async (req, res) => {
      try {
        const locationId = req.query.locationId as string | undefined;
        const folders = this.memoryManager.listBackupFolders(locationId);
        res.json({ folders });
      } catch (error: any) {
        console.error('❌ Backup folders error:', error);
        res.status(500).json({ error: error.message || 'Failed to list folders' });
      }
    });

    this.app.post('/api/data/backup-folders', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const { name, locationId } = req.body;
        if (!name) {
          res.status(400).json({ error: 'Folder name is required' });
          return;
        }

        this.memoryManager.auditLog(
          'backup_folder_create',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ name, locationId })
        );

        const result = this.memoryManager.createBackupFolder(name, locationId);
        res.json(result);
      } catch (error: any) {
        console.error('❌ Create folder error:', error);
        res.status(500).json({ error: error.message || 'Failed to create folder' });
      }
    });

    this.app.post('/api/data/snapshots', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const label = req.body?.label as string | undefined;
        const locationId = req.body?.locationId as string | undefined;
        const folder = req.body?.folder as string | undefined;

        this.memoryManager.auditLog(
          'snapshot_create',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ label, locationId, folder })
        );

        const snapshot = await this.memoryManager.createSnapshot(label, locationId, folder);
        res.json(snapshot);
      } catch (error: any) {
        console.error('❌ Snapshot create error:', error);
        res.status(500).json({ error: error.message || 'Failed to create snapshot' });
      }
    });

    this.app.get('/api/data/snapshots', async (req, res) => {
      try {
        const locationId = req.query.locationId as string | undefined;
        const snapshots = this.memoryManager.listSnapshots(locationId);
        res.json({ snapshots });
      } catch (error: any) {
        console.error('❌ Snapshot list error:', error);
        res.status(500).json({ error: error.message || 'Failed to list snapshots' });
      }
    });

    this.app.post('/api/data/snapshots/:id/move', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const { locationId, folder } = req.body;
        if (!locationId) {
          res.status(400).json({ error: 'Target locationId is required' });
          return;
        }

        this.memoryManager.auditLog(
          'snapshot_move',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ snapshotId: req.params.id, locationId, folder })
        );

        const result = await this.memoryManager.moveSnapshot(req.params.id, locationId, folder);
        res.json(result);
      } catch (error: any) {
        console.error('❌ Snapshot move error:', error);
        res.status(500).json({ error: error.message || 'Failed to move snapshot' });
      }
    });

    this.app.delete('/api/data/snapshots/:id', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;

        this.memoryManager.auditLog(
          'snapshot_delete',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ snapshotId: req.params.id })
        );

        const result = this.memoryManager.deleteSnapshot(req.params.id);
        res.json(result);
      } catch (error: any) {
        console.error('❌ Snapshot delete error:', error);
        res.status(500).json({ error: error.message || 'Failed to delete snapshot' });
      }
    });

    this.app.post('/api/data/snapshots/:id/restore', async (req, res) => {
      try {
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;

        if (req.body?.confirm !== true) {
          res.status(400).json({ error: 'Must pass { confirm: true } to restore' });
          return;
        }

        this.memoryManager.auditLog(
          'snapshot_restore',
          context.userId || context.apiKeyId || 'unknown',
          JSON.stringify({ snapshotId: req.params.id })
        );

        this.restoring = true;
        try {
          const result = await this.memoryManager.restoreSnapshot(req.params.id);
          res.json(result);
        } finally {
          this.restoring = false;
        }
      } catch (error: any) {
        console.error('❌ Snapshot restore error:', error);
        this.restoring = false;
        res.status(500).json({ error: error.message || 'Failed to restore snapshot' });
      }
    });

    // ─── Dashboard API: Agent Status ───
    this.app.get('/api/agent-status', async (req, res) => {
      try {
        if (!requireAgentScope(req, res, 'dashboard:read')) return;
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const tenantId = context.tenantId || 'default';
        const db = this.memoryManager.getDb();
        // Canonical-only roster by default; ?raw=true returns every registration.
        const includeRaw = req.query.raw === 'true' || req.query.includeEphemeral === 'true';

        // Read from the canonical agent_registrations table (same source as the
        // get_agent_status MCP tool), not the legacy shared_memory blobs.
        let rows: any[] = [];
        try {
          rows = db.prepare(
            `SELECT agent_id, name, capabilities_json, metadata_json, status, updated_at, created_at
             FROM agent_registrations WHERE tenant_id = ? ORDER BY updated_at DESC`
          ).all(tenantId) as any[];
        } catch {
          // table may not exist yet
        }

        const parseJson = (raw: string | null | undefined, fallback: any) => {
          if (!raw) return fallback;
          try { return JSON.parse(raw); } catch { return fallback; }
        };
        // An id minted per bridge process: agent-<host>-<pid digits>-<base36ts>.
        const isEphemeralId = (id: string) => /^agent-.+-\d+-.+$/.test(id);
        const computeStatus = (lastSeen: string) => {
          const ageMs = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Infinity;
          if (ageMs < 5 * 60 * 1000) return 'active';
          if (ageMs < 30 * 60 * 1000) return 'idle';
          return 'offline';
        };
        const effectiveStatus = (row: any, metadata: any, lastSeen: string) => {
          if (row.status && row.status !== 'active') return row.status;
          const expiresAt = metadata?.expiresAt || metadata?.expires_at;
          const expiresMs = expiresAt ? Date.parse(String(expiresAt)) : NaN;
          if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return 'expired';
          return computeStatus(lastSeen);
        };
        const messageCountFor = (agentId: string) => {
          try {
            const r = db.prepare(
              'SELECT COUNT(*) as cnt FROM ai_messages WHERE tenant_id = ? AND (from_agent = ? OR to_agent = ?)'
            ).get(tenantId, agentId, agentId) as { cnt: number } | undefined;
            return r?.cnt ?? 0;
          } catch { return 0; }
        };

        if (includeRaw) {
          // Raw mode: one item per registration row (diagnostics).
          const agents = rows.map((row: any) => {
            const metadata = parseJson(row.metadata_json, {});
            const lastSeen = row.updated_at || row.created_at || new Date().toISOString();
            return {
              canonicalAgentId: this.memoryManager.inferCanonicalAgentId(row.agent_id, row.name, metadata),
              agentId: row.agent_id,
              displayName: row.name || row.agent_id,
              status: effectiveStatus(row, metadata, lastSeen),
              isEphemeral: isEphemeralId(row.agent_id),
              lastSeen,
              expiresAt: metadata.expiresAt,
              eventsCount: messageCountFor(row.agent_id),
              capabilities: parseJson(row.capabilities_json, []),
            };
          });
          res.json({ totalRegistrations: rows.length, returnedRegistrations: agents.length, raw: true, agents });
          return;
        }

        // Default: canonical rollup — one entry per logical agent, ephemerals folded in.
        const canonicalMap = new Map<string, any>();
        for (const row of rows) {
          const metadata = parseJson(row.metadata_json, {});
          const canonicalAgentId = this.memoryManager.inferCanonicalAgentId(row.agent_id, row.name, metadata);
          const lastSeen = row.updated_at || row.created_at || '';
          const existing = canonicalMap.get(canonicalAgentId);
          if (!existing) {
            canonicalMap.set(canonicalAgentId, {
              canonicalAgentId,
              displayName: row.name || canonicalAgentId,
              status: effectiveStatus(row, metadata, lastSeen),
              isEphemeral: isEphemeralId(canonicalAgentId),
              lastSeen,
              expiresAt: metadata.expiresAt,
              capabilities: parseJson(row.capabilities_json, []),
              _sessions: 1,
            });
          } else {
            existing._sessions += 1;
            if (String(lastSeen) > String(existing.lastSeen)) {
              existing.lastSeen = lastSeen;
              existing.displayName = row.name || existing.displayName;
              existing.status = effectiveStatus(row, metadata, lastSeen);
              existing.expiresAt = metadata.expiresAt || existing.expiresAt;
            }
            existing.capabilities = Array.from(new Set([...existing.capabilities, ...parseJson(row.capabilities_json, [])]));
          }
        }
        const agents = Array.from(canonicalMap.values())
          .map((a) => ({ ...a, eventsCount: messageCountFor(a.canonicalAgentId) }))
          .sort((x, y) => String(y.lastSeen).localeCompare(String(x.lastSeen)));

        res.json({
          totalRegistrations: rows.length,
          totalCanonicalAgents: agents.length,
          returnedCanonicalAgents: agents.length,
          raw: false,
          agents,
        });
      } catch (error: any) {
        console.error('Dashboard agent-status error:', error);
        res.status(500).json({ error: error.message || 'Failed to get agent status' });
      }
    });

    // ─── Dashboard API: Recent Events (individual messages for event feed) ───
    this.app.get('/api/recent-events', async (req, res) => {
      try {
        if (!requireAgentScope(req, res, 'dashboard:read')) return;
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const tenantId = context.tenantId || 'default';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const since = (req.query.since as string) || '';
        const db = this.memoryManager.getDb();

        let messages: any[] = [];
        const unreadByAgent: Record<string, number> = {};
        try {
          // read_at IS NULL => unread; archived_at IS NULL => not archived. The
          // dashboard derives isRead/isArchived from these (Engram comms surface).
          const cols = 'id, from_agent, to_agent, content, message_type, created_at, read_at, archived_at';
          if (since) {
            messages = db.prepare(
              `SELECT ${cols}
               FROM ai_messages
               WHERE tenant_id = ? AND created_at > ?
               ORDER BY created_at DESC LIMIT ?`
            ).all(tenantId, since, limit) as any[];
          } else {
            messages = db.prepare(
              `SELECT ${cols}
               FROM ai_messages
               WHERE tenant_id = ?
               ORDER BY created_at DESC LIMIT ?`
            ).all(tenantId, limit) as any[];
          }
          // Per-recipient unread counts across the whole tenant (not just the
          // returned page), so the inbox badge stays accurate past the limit.
          const unreadRows = db.prepare(
            `SELECT to_agent, COUNT(*) as cnt
             FROM ai_messages
             WHERE tenant_id = ? AND read_at IS NULL AND archived_at IS NULL
             GROUP BY to_agent`
          ).all(tenantId) as any[];
          for (const r of unreadRows) unreadByAgent[r.to_agent] = r.cnt;
        } catch {
          // ai_messages may not exist
        }

        res.json({ messages, unreadByAgent });
      } catch (error: any) {
        console.error('Dashboard recent-events error:', error);
        res.status(500).json({ error: error.message || 'Failed to get recent events' });
      }
    });

    // ─── Dashboard API: Analytics ───
    this.app.get('/api/analytics', async (req, res) => {
      try {
        if (!requireAgentScope(req, res, 'dashboard:read')) return;
        const context = (req as TenantRequest).requestContext || DEFAULT_REQUEST_CONTEXT;
        const tenantId = context.tenantId || 'default';
        const db = this.memoryManager.getDb();

        // Overview metrics (tenant-scoped)
        let totalEvents = 0;
        let activeAgents = 0;
        let agentPerformance: any[] = [];
        let eventTypes: any[] = [];

        try {
          const evtRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM ai_messages WHERE tenant_id = ?'
          ).get(tenantId) as { cnt: number } | undefined;
          totalEvents = evtRow?.cnt ?? 0;

          const agentRows = db.prepare(
            'SELECT from_agent, COUNT(*) as cnt FROM ai_messages WHERE tenant_id = ? GROUP BY from_agent ORDER BY cnt DESC'
          ).all(tenantId) as Array<{ from_agent: string; cnt: number }>;
          activeAgents = agentRows.length;
          agentPerformance = agentRows.map((r) => ({
            name: r.from_agent,
            events: r.cnt,
            successRate: null,
            avgTime: null,
          }));

          const typeRows = db.prepare(
            'SELECT message_type, COUNT(*) as cnt FROM ai_messages WHERE tenant_id = ? GROUP BY message_type ORDER BY cnt DESC'
          ).all(tenantId) as Array<{ message_type: string; cnt: number }>;
          eventTypes = typeRows.map((r) => ({
            type: r.message_type || 'unknown',
            count: r.cnt,
            percentage: totalEvents > 0 ? Math.round((r.cnt / totalEvents) * 1000) / 10 : 0,
          }));
        } catch {
          // ai_messages may not exist
        }

        // Entity/relation/observation counts from shared_memory by memory_type (tenant-scoped)
        let entityCount = 0;
        let relationCount = 0;
        let observationCount = 0;
        try {
          const graphCounts = db.prepare(
            `SELECT memory_type, COUNT(*) as cnt FROM shared_memory
             WHERE tenant_id = ? AND memory_type IN ('entity', 'relation', 'observation')
             GROUP BY memory_type`
          ).all(tenantId) as Array<{ memory_type: string; cnt: number }>;
          for (const r of graphCounts) {
            if (r.memory_type === 'entity') entityCount = r.cnt;
            else if (r.memory_type === 'relation') relationCount = r.cnt;
            else if (r.memory_type === 'observation') observationCount = r.cnt;
          }
        } catch {
          // shared_memory may not exist
        }

        // 6 time buckets for trends (last 24h, tenant-scoped)
        const trendLabels: string[] = [];
        const trendEvents: number[] = [];
        const trendSuccessRates: number[] = [];
        try {
          const bucketMs = 86400_000 / 6;
          for (let i = 0; i < 6; i++) {
            const start = new Date(Date.now() - 86400_000 + i * bucketMs);
            const end = new Date(Date.now() - 86400_000 + (i + 1) * bucketMs);
            trendLabels.push(start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            const row = db.prepare(
              'SELECT COUNT(*) as cnt FROM ai_messages WHERE tenant_id = ? AND created_at >= ? AND created_at < ?'
            ).get(tenantId, start.toISOString(), end.toISOString()) as { cnt: number } | undefined;
            trendEvents.push(row?.cnt ?? 0);
            trendSuccessRates.push(null as any);
          }
        } catch {
          // ai_messages may not exist
        }

        // Real DB size from SQLite PRAGMA (page_count * page_size), replacing the
        // dashboard's byte-estimate heuristic which is wildly off after compaction.
        let actualDbBytes: number | null = null;
        let dbSizeSource: string | null = null;
        let dbSizeAt: string | null = null;
        try {
          const sizeRow = db.prepare(
            'SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes'
          ).get() as { bytes: number } | undefined;
          if (sizeRow && typeof sizeRow.bytes === 'number') {
            actualDbBytes = sizeRow.bytes;
            dbSizeSource = 'pragma';
            dbSizeAt = new Date().toISOString();
          }
        } catch {
          // pragma may be unavailable; leave actualDbBytes null and let the client fall back
        }

        const memUsage = process.memoryUsage();
        res.json({
          overview: {
            totalEvents,
            activeAgents,
            successRate: null,
            avgResponseTime: null,
            entityCount,
            relationCount,
            observationCount,
            actualDbBytes,
            dbSizeSource,
            dbSizeAt,
          },
          trends: {
            labels: trendLabels,
            events: trendEvents,
            successRates: trendSuccessRates,
          },
          agentPerformance,
          eventTypes,
          systemHealth: {
            cpu: null,
            memory: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
            network: null,
            storage: null,
          },
        });
      } catch (error: any) {
        console.error('Dashboard analytics error:', error);
        res.status(500).json({ error: error.message || 'Failed to get analytics' });
      }
    });

    // Comprehensive system status endpoint
    this.app.get('/system/status', async (req, res) => {
      try {
        if (!requireAgentScope(req, res, 'ops:read')) return;
        const memoryStatus = await this.memoryManager.getSystemStatus();
        
        const memoryStats = {
          individualAgents: this.memoryManager.getMemorySystem().individual.size,
          sharedKnowledge: this.memoryManager.getSharedMemory().knowledge.length,
          activeTasks: this.memoryManager.getSharedMemory().tasks.tasks.size,
          projectArtifacts: this.memoryManager.getSharedMemory().artifacts.length,
          consensusDecisions: this.memoryManager.getSharedMemory().decisions.length
        };

        let advancedStats: any = {};
        if (memoryStatus.advancedSystemsEnabled) {
          try {
            const vectorConnected = memoryStatus.vector?.connected ?? memoryStatus.weaviate?.connected;
            if (vectorConnected && this.memoryManager.vectorClient) {
              const vectorStats = await this.memoryManager.vectorClient.getStatistics();
              advancedStats.vector = vectorStats;
              advancedStats.weaviate = vectorStats; // legacy alias for existing dashboard clients
            }
          } catch (statsError) {
            console.warn('⚠️ Error getting advanced system statistics:', statsError);
          }
        }

        const systemStatus = {
          timestamp: new Date().toISOString(),
          service: HYTHE_SERVICE_NAME,
          version: HYTHE_VERSION,
          uptime: process.uptime(),
          memory: {
            used: process.memoryUsage(),
            system: memoryStats
          },
          databases: memoryStatus,
          advanced: advancedStats,
          messageHub: this.messageHub ? {
            enabled: true,
            port: this.messageHub.getPort(),
            status: 'active'
          } : {
            enabled: false
          },
          capabilities: {
            'advanced-memory-systems': true,
            'multi-provider-ai': true,
            'autonomous-agents': true,
            'real-time-collaboration': true,
            'cross-platform-support': true,
            'consensus-coordination': true,
            'ml-integration': true,
            'event-driven-orchestration': true
          },
          endpoints: {
            health: `/health`,
            aiMessages: `/ai-message`,
            getMessages: `/ai-messages/:agentId`,
            mcpProtocol: `/mcp`,
            systemStatus: `/system/status`
          }
        };

        res.json(systemStatus);
      } catch (error) {
        console.error('❌ System status error:', error);
        res.status(500).json({ 
          error: 'Failed to get system status',
          message: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  private async registerWithUnifiedServer() {
    try {
      const baseUrl = process.env.UNIFIED_SERVER_URL;
      if (!baseUrl) {
        console.debug('Unified server URL not set; skipping registration');
        return;
      }
      const response = await fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentId: this.agentId,
          name: 'Unified Neural MCP Server',
          capabilities: [
            'advanced-memory-systems',
            'multi-provider-ai',
            'autonomous-agents',
            'real-time-collaboration',
            'cross-platform-support',
            'consensus-coordination',
            'ml-integration',
            'event-driven-orchestration'
          ],
          sessionId: this.sessionId,
          endpoint: `http://localhost:${this.port}`
        })
      });
      
      if (response.ok) {
        console.log('✅ Unified Neural MCP Server registered with unified platform');
      } else {
        console.warn('⚠️ Failed to register with unified platform:', response.status);
      }
    } catch (error) {
      console.warn('⚠️ Unified server not available:', error);
    }
  }

  private async publishEventToUnified(type: string, payload: any) {
    try {
      const baseUrl = process.env.UNIFIED_SERVER_URL;
      if (!baseUrl) return; // Silently skip when not configured
      await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentId: this.agentId,
          sessionId: this.sessionId,
          type,
          payload
        })
      });
    } catch (error) {
      console.warn('⚠️ Failed to publish event to unified server:', error);
    }
  }

  private _handleResourceRead(uri: string, context: RequestContext = DEFAULT_REQUEST_CONTEXT) {
    bindMessageResourceRecipient(uri, context, this.agentCredentialStore);
    return readEng4Resource(this.memoryManager.getDb(), context.tenantId, uri);
  }

  private async _handleToolsList() {
    // v1 TOOL DIET (Step-3, TOOL-COMPATIBILITY-MAP.md): discovery is built
    // EXCLUSIVELY from the retained registry + the two ENG-4 primitives —
    // a retired tool can never linger in tools/list accidentally.
    return {
      tools: [
        ...RETAINED_LEGACY_TOOLS.map((name) => ({
          name: UnifiedToolSchemas[name].name,
          description: UnifiedToolSchemas[name].description,
          inputSchema: UnifiedToolSchemas[name].inputSchema,
        })),
        ...ENG4_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ],
    };
  }

  /** NE-S6 gate on eng4 writes: every caller-supplied prose field is
   * sanitized before checkpoint delegation; flagged content audits + throws
   * exactly like the legacy end_session path. */
  private _sanitizeCheckpointArgs(operation: string, args: any, agent: string) {
    const prose: string[] = [];
    const state = args?.state ?? {};
    for (const value of [state.objective, state.status, ...(state.nextActions ?? []), ...(state.blockers ?? []), ...(state.guardrails ?? [])]) {
      if (typeof value === 'string') prose.push(value);
    }
    for (const event of args?.events ?? []) {
      if (typeof event?.summary === 'string') prose.push(event.summary);
    }
    for (const change of args?.factChanges ?? []) {
      for (const value of [change?.assertion?.subject, change?.assertion?.predicate, change?.assertion?.object]) {
        if (typeof value === 'string') prose.push(value);
      }
    }
    for (const change of args?.loopChanges ?? []) {
      if (typeof change?.nextAction === 'string') prose.push(change.nextAction);
      if (typeof change?.closeOutcome === 'string') prose.push(change.closeOutcome);
    }
    for (const value of prose) {
      const check = MemoryManager.sanitizeContent(value);
      if (!check.safe) {
        this.memoryManager.auditLog(operation, agent, value, 'eng4-checkpoint', true, check.reason);
        this.notificationPort.send(`⚠️ Neural write flagged — agent: ${agent}, operation: ${operation}, reason: ${check.reason}`).catch(() => {});
        throw new Error(`Content flagged by sanitizer: ${check.reason}`);
      }
    }
  }

  private async _handleToolCall(name: string, args: any = {}, context: RequestContext = DEFAULT_REQUEST_CONTEXT) {
    try {
      args = bindAgentInvocation(name, args, context, this.agentCredentialStore);
      const agent = args.agentId || args.from || this.agentId;
      const tenantId = context.tenantId;

      // ENG-4 primitives: schema+handler registered atomically in
      // eng4/register.ts; outputs are frozen-schema-validated in EVERY
      // build before any transport object exists. checkpoint WRITES keep
      // the NE-S6 sanitizer gate (legacy end_session had it; the wrapper
      // conversion must not weaken a security control).
      if (name === 'checkpoint') {
        this._sanitizeCheckpointArgs('checkpoint', args, agent);
      }
      if (name === 'resume' || name === 'checkpoint') {
        return handleEng4Tool(name, args, {
          db: this.memoryManager.getDb(),
          directory: this.memoryManager as any,
          tenantId,
        });
      }
      const registrationActor = context.userId || context.apiKeyId || this.agentId;
      const parseRegistrationJson = (raw: string | null | undefined, fallback: any) => {
        if (!raw) return fallback;
        try {
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      };
      const registrationExpiresAt = (metadata: any): string | undefined => {
        const value = metadata?.expiresAt || metadata?.expires_at;
        if (typeof value !== 'string' || !value.trim()) return undefined;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
      };
      const isRegistrationExpired = (metadata: any, nowMs: number = Date.now()) => {
        const expiresAt = registrationExpiresAt(metadata);
        return !!expiresAt && Date.parse(expiresAt) <= nowMs;
      };
      const effectiveRegistrationStatus = (status: string | undefined, metadata: any, nowMs: number = Date.now()) => {
        const storedStatus = status || 'unknown';
        if (storedStatus === 'active' && isRegistrationExpired(metadata, nowMs)) return 'expired';
        return storedStatus;
      };

      // Task 1100: Update last_seen_tz when user has a timezone hint
      if (context.userId && context.timezoneHint) {
        this.memoryManager.updateLastSeenTz(context.userId, context.timezoneHint, tenantId);
      }

      switch (name) {
        // === MEMORY & KNOWLEDGE MANAGEMENT ===
        case 'create_entities': {
          const { entities } = args;

          // NE-S6c fix: Sanitize entity observations
          for (const entity of entities) {
            const entityReferences = [
              entity.name,
              ...(Array.isArray(entity.aliases) ? entity.aliases : []),
            ];
            if (
              String(entity.entityType || entity.type || '').trim().toLowerCase() === 'message_detail'
              || entityReferences.some((reference) =>
                this.memoryManager.isConfidentialEntityReference(reference, tenantId))
            ) {
              throw new Error('message_detail is reserved for private mailbox compatibility');
            }
            if (Array.isArray(entity.observations)) {
              for (const obs of entity.observations) {
                const check = MemoryManager.sanitizeContent(obs);
                if (!check.safe) {
                  this.memoryManager.auditLog('create_entity', agent, obs, entity.name, true, check.reason);
                  this.notificationPort.send(`⚠️ Neural write flagged — agent: ${agent}, operation: create_entity, reason: ${check.reason}`).catch(() => {});
                  throw new Error(`Content flagged by sanitizer: ${check.reason}`);
                }
              }
            }
            const structuredFields = [
              ...(Array.isArray(entity.aliases) ? entity.aliases : []),
              ...(Array.isArray(entity.agentBootstrap) ? entity.agentBootstrap : []),
              ...(entity.metadata ? [JSON.stringify(entity.metadata)] : []),
            ].filter((value) => typeof value === 'string');
            for (const field of structuredFields) {
              const check = MemoryManager.sanitizeContent(field);
              if (!check.safe) {
                this.memoryManager.auditLog('create_entity', agent, field, entity.name, true, check.reason);
                this.notificationPort.send(`⚠️ Neural write flagged — agent: ${agent}, operation: create_entity, reason: ${check.reason}`).catch(() => {});
                throw new Error(`Content flagged by sanitizer: ${check.reason}`);
              }
            }
          }

          const createdEntities = await Promise.all(entities.map(async (entity: any) => {
            const entityMetadata = {
              ...(entity.metadata && typeof entity.metadata === 'object' ? entity.metadata : {}),
              vectorEmbedded: true,
              graphIndexed: true,
              cacheEnabled: true
            };
            const entityData = {
              name: entity.name,
              type: entity.entityType,
              aliases: Array.isArray(entity.aliases) ? entity.aliases : [],
              agentBootstrap: Array.isArray(entity.agentBootstrap) ? entity.agentBootstrap : [],
              observations: entity.observations,
              createdBy: agent,
              timestamp: new Date().toISOString(),
              metadata: entityMetadata
            };

            const entityId = await this.memoryManager.store(agent, entityData, 'shared', 'entity', tenantId, context);
            const materializedInlineObservations = await this.memoryManager.materializeInlineObservations(
              agent,
              entityId,
              entity.name,
              entityData.observations,
              tenantId,
              context
            );

            // NE-S6b: Audit log
            this.memoryManager.auditLog('create_entity', agent, JSON.stringify(entityData), entity.name);

            return { id: entityId, ...entityData, materializedInlineObservations };
          }));

          await this.publishEventToUnified('knowledge.entities.created', {
            entities: createdEntities,
            agent: agent
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  created: createdEntities.length,
                  entities: createdEntities,
                  advancedFeatures: {
                    vectorEmbeddings: 'generated',
                    graphRelations: 'indexed'
                  }
                }, null, 2),
              },
            ],
          };
        }

        case 'search_entities': {
          const {
            query,
            searchType = 'hybrid',
            limit = 50,
            compact = true,
            offset = 0,
            maxResponseSize = 40000,
            memoryType,
            agentFilter,
            sortBy = 'relevance',
            canonicalEntityKey,
            memoryTypes,
            includeRedundantRepresentations = false,
          } = args;
          const normalizedSearchType = String(searchType).toLowerCase();
          const exactSearch = normalizedSearchType === 'exact';
          const semanticSearch = normalizedSearchType === 'semantic';
          const normalizedSortBy = String(sortBy).toLowerCase() === 'recency' ? 'recency' : 'relevance';
          const normalizedCanonicalEntityKey = typeof canonicalEntityKey === 'string'
            ? this.memoryManager.canonicalEntityKey(canonicalEntityKey)
            : '';
          const requestedMemoryTypes = new Set(
            (Array.isArray(memoryTypes) ? memoryTypes : [])
              .map((value: any) => String(value).trim().toLowerCase())
              .filter(Boolean)
          );

          // Recall-quality type weighting. The searchable corpus is ~85% chat
          // messages + raw observations vs ~10% curated entities, so raw vector
          // distance buries entities: an eval over 10 representative queries
          // found an entity in the top-5 only 4/10 times (none in top-10 for
          // 6/10). Weight the semantic similarity by source type so curated
          // knowledge surfaces above equally-similar chatter, and plumbing rows
          // (registrations/preferences/identity) are pushed down. Conservative
          // by design (a nudge, not a veto) and env-tunable.
          const typeWeight = (mt: string | undefined): number => {
            switch (mt) {
              case 'entity': return parseFloat(process.env.RECALL_W_ENTITY || '1.0');
              case 'observation': return parseFloat(process.env.RECALL_W_OBSERVATION || '0.95');
              case 'relation': return parseFloat(process.env.RECALL_W_RELATION || '0.9');
              case 'learning': return parseFloat(process.env.RECALL_W_LEARNING || '0.85');
              case 'ai_message': return parseFloat(process.env.RECALL_W_MESSAGE || '0.6');
              case 'agent_registration':
              case 'agent_identity':
              case 'preferences': return parseFloat(process.env.RECALL_W_PLUMBING || '0.3');
              default: return 0.8;
            }
          };

          const parseOriginalContent = (content: any): any | null => {
            if (!content?.original || typeof content.original !== 'string') return null;
            try {
              return JSON.parse(content.original);
            } catch {
              return null;
            }
          };

          const getContentPayload = (result: any): any => {
            return parseOriginalContent(result.content) || result.content || {};
          };

          const getStorageMemoryType = (result: any): string | undefined => {
            const payload = getContentPayload(result);
            if (result.memoryType) return result.memoryType;
            if (result.storageMemoryType) return result.storageMemoryType;
            if (payload?.memoryType) return payload.memoryType;
            if (payload?.memory_type) return payload.memory_type;
            if (payload?.entityName && Array.isArray(payload?.contents)) return 'observation';
            if (payload?.from && payload?.to && payload?.relationType) return 'relation';
            if (payload?.name && Array.isArray(payload?.observations)) return 'entity';
            return undefined;
          };

          const getDomainType = (result: any): string | undefined => {
            const payload = getContentPayload(result);
            return payload?.entityType || payload?.type;
          };

          const getEntityName = (result: any): string | undefined => {
            const payload = getContentPayload(result);
            return payload?.name || payload?.entityName;
          };

          const parseMatchedLookupKinds = (value: any): string[] => {
            if (Array.isArray(value)) {
              return Array.from(new Set(value.map((kind) => String(kind).trim()).filter(Boolean)));
            }
            return Array.from(new Set(String(value || '')
              .split(',')
              .map((kind) => kind.trim())
              .filter(Boolean)));
          };

          const lookupKindsToOrigins = (kinds: string[]): string[] => {
            const origins = new Set<string>();
            for (const kind of kinds) {
              if (kind === 'canonical_name') origins.add('name');
              else if (kind === 'alias') origins.add('alias');
              else if (kind === 'embedded_observation_handle') origins.add('observation_prose');
              else if (kind === 'agent_bootstrap_handle') origins.add('agent_bootstrap');
              else if (kind === 'entity_name') origins.add('entity_name');
              else if (kind === 'applies_to' || kind === 'metadata_applies_to') origins.add('applies_to');
              else if (kind === 'observation_handle') origins.add('observation_prose');
              else if (kind === 'canonical_fact_handle') origins.add('canonical_fact');
              else if (kind === 'relation_from') origins.add('relation_from');
              else if (kind === 'relation_to') origins.add('relation_to');
              else origins.add(kind);
            }
            return Array.from(origins);
          };

          const rowToSearchResult = (row: any, storageMemoryType: 'entity' | 'observation' | 'relation', flags: Record<string, boolean>) => {
            let content: any;
            try {
              content = JSON.parse(row.content || '{}');
            } catch {
              content = { raw: row.content, type: storageMemoryType };
            }
            const matchedLookupKinds = parseMatchedLookupKinds(row.lookup_key_kinds);
            return {
              id: row.id,
              type: 'shared',
              content,
              relevance: 1,
              source: row.created_by,
              timestamp: new Date(row.created_at),
              memoryType: storageMemoryType,
              lookupWeight: row.lookup_weight,
              matchedLookupKinds,
              matchOrigins: lookupKindsToOrigins(matchedLookupKinds),
              ...flags,
            };
          };

          const scoreAndDecorate = (results: any[]) => results.map((result: any) => {
            const payload = getContentPayload(result);
            const lowerQuery = query.toLowerCase();
            const nameMatch = getEntityName(result)?.toLowerCase().includes(lowerQuery);
            const typeMatch = getDomainType(result)?.toLowerCase().includes(lowerQuery);
            const contentMatch = normalizedCanonicalEntityKey.length > 0 &&
              JSON.stringify(payload).toLowerCase().includes(lowerQuery);
            // Semantic similarity (0..1) propagated from the vec0 distance, if any.
            // Previously this was dropped and every semantic hit got a flat 0.6,
            // so results fell back to arbitrary order — irrelevant rows ranked
            // above the bullseye. Use it to rank semantic hits in a band below
            // exact matches (exact stays authoritative), so closer vectors win.
            const semSim = typeof result.semanticSimilarity === 'number'
              ? result.semanticSimilarity
              : (typeof result.distance === 'number' ? 1 / (1 + result.distance) : null);
            // Apply type weighting to the semantic band so curated entities/
            // observations outrank equally-similar chat messages and plumbing.
            const weightedSemSim = semSim !== null
              ? semSim * typeWeight(getStorageMemoryType(result))
              : null;
            const score = result.exactEntityMatch ? 1.1 :
                          result.exactObservationMatch ? 1.05 :
                          result.exactRelationMatch ? 1.0 :
                          nameMatch ? 1.0 :
                          typeMatch ? 0.8 :
                          contentMatch ? 0.75 :
                          weightedSemSim !== null ? 0.5 + 0.4 * weightedSemSim : // 0.5..0.9 band, type-weighted
                          0.6;
            const entry: any = {
              ...result,
              searchScore: score,
              searchType: searchType,
              storageMemoryType: getStorageMemoryType(result),
              entityType: getDomainType(result),
              canonicalEntityName: getEntityName(result),
              memorySource: result.source?.startsWith('sqlite-vec:') ? 'sqlite-vec' :
                            result.source?.startsWith('weaviate:') ? 'sqlite-vec' : 'sqlite',
              semanticSimilarity: semSim,
              matchedLookupKinds: parseMatchedLookupKinds(result.matchedLookupKinds),
              matchOrigins: Array.isArray(result.matchOrigins)
                ? Array.from(new Set(result.matchOrigins.map((origin: any) => String(origin).trim()).filter(Boolean)))
                : lookupKindsToOrigins(parseMatchedLookupKinds(result.matchedLookupKinds)),
            };
            if (payload?.metadata?.kind || payload?.metadata?.canonicalFact || payload?.metadata?.supersedes) {
              entry.structuredObservation = payload.metadata;
            }
            if (result.chunked) {
              entry.chunked = true;
              entry.contentSize = result.contentSize;
              entry.totalChunks = result.totalChunks;
            }
            return entry;
          }).sort((a: any, b: any) => b.searchScore - a.searchScore);

          const resultTimestamp = (result: any): number => {
            const value = result?.timestamp || result?.createdAt || result?.content?.timestamp;
            if (value instanceof Date) return value.getTime();
            const parsed = Date.parse(String(value || ''));
            return Number.isFinite(parsed) ? parsed : 0;
          };

          const sortFilteredResults = (results: any[]): any[] => {
            if (normalizedSortBy !== 'recency') return results;
            return [...results].sort((a: any, b: any) =>
              resultTimestamp(b) - resultTimestamp(a) ||
              b.searchScore - a.searchScore ||
              String(a.id || '').localeCompare(String(b.id || ''))
            );
          };

          const inlineObservationRepresentationKey = (result: any): string | null => {
            const payload = getContentPayload(result);
            if ((result.storageMemoryType || getStorageMemoryType(result)) !== 'observation') return null;
            const metadata = payload?.metadata || {};
            if (metadata.source !== 'create_entities_inline') return null;
            if (!metadata.entityId || !metadata.contentHash) return null;
            return `${metadata.entityId}:${metadata.contentHash}`;
          };

          const entityInlineObservationRepresentationKeys = (result: any): Set<string> => {
            const keys = new Set<string>();
            const payload = getContentPayload(result);
            if ((result.storageMemoryType || getStorageMemoryType(result)) !== 'entity') return keys;
            if (!Array.isArray(payload?.observations)) return keys;

            for (const observation of payload.observations) {
              if (typeof observation !== 'string' || !observation.trim()) continue;
              keys.add(`${result.id}:${MemoryManager.contentHash(observation)}`);
            }
            return keys;
          };

          const matchedSolelyByEmbeddedObservation = (result: any): boolean => {
            if ((result.storageMemoryType || getStorageMemoryType(result)) !== 'entity') return false;
            const kinds = parseMatchedLookupKinds(result.matchedLookupKinds);
            return kinds.length > 0 && kinds.every((kind) => kind === 'embedded_observation_handle');
          };

          const dropRedundantRepresentations = (results: any[]) => {
            if (includeRedundantRepresentations) {
              return { results, redundantRepresentationCount: 0 };
            }

            const materializedInlineKeys = new Set<string>();
            for (const result of results) {
              const key = inlineObservationRepresentationKey(result);
              if (key) materializedInlineKeys.add(key);
            }

            if (materializedInlineKeys.size === 0) {
              return { results, redundantRepresentationCount: 0 };
            }

            const filtered: any[] = [];
            let redundantRepresentationCount = 0;
            for (const result of results) {
              if (!matchedSolelyByEmbeddedObservation(result)) {
                filtered.push(result);
                continue;
              }

              const entityKeys = entityInlineObservationRepresentationKeys(result);
              const hasMaterializedTwin = Array.from(entityKeys).some((key) => materializedInlineKeys.has(key));
              if (hasMaterializedTwin) {
                redundantRepresentationCount++;
                continue;
              }

              filtered.push(result);
            }

            return { results: filtered, redundantRepresentationCount };
          };

          const dedupAndFilter = (scored: any[]) => {
            const dedupMap = new Map<string, any>();
            for (const result of scored) {
              const storageType = result.storageMemoryType || getStorageMemoryType(result);
              const entityName = storageType === 'entity'
                ? (result.canonicalEntityName || getEntityName(result) || result.id || '').toLowerCase()
                : (result.id || '').toLowerCase();
              const existing = dedupMap.get(entityName);
              if (!existing) {
                result.sources = [result.memorySource];
                dedupMap.set(entityName, result);
              } else if (result.searchScore > existing.searchScore) {
                result.sources = Array.from(new Set([...(existing.sources || []), result.memorySource]));
                dedupMap.set(entityName, result);
              } else {
                existing.sources = Array.from(new Set([...(existing.sources || []), result.memorySource]));
              }
            }

            let filteredResults = Array.from(dedupMap.values()).filter((result: any) =>
              !this.memoryManager.isConfidentialGraphRow(
                result.storageMemoryType || getStorageMemoryType(result),
                getContentPayload(result),
                tenantId,
              )
            );
            if (memoryType) {
              const filterLower = String(memoryType).toLowerCase();
              filteredResults = filteredResults.filter((r: any) =>
                String(r.type || '').toLowerCase() === filterLower ||
                String(r.storageMemoryType || getStorageMemoryType(r) || '').toLowerCase() === filterLower ||
                String(r.entityType || getDomainType(r) || '').toLowerCase() === filterLower
              );
            }
            if (requestedMemoryTypes.size > 0) {
              filteredResults = filteredResults.filter((r: any) =>
                requestedMemoryTypes.has(String(r.storageMemoryType || getStorageMemoryType(r) || '').toLowerCase())
              );
            }
            if (normalizedCanonicalEntityKey) {
              filteredResults = filteredResults.filter((r: any) => {
                const payload = getContentPayload(r);
                const storageType = r.storageMemoryType || getStorageMemoryType(r);
                if (storageType === 'relation') {
                  return [payload?.from, payload?.to]
                    .some((value) => this.memoryManager.canonicalEntityKey(value) === normalizedCanonicalEntityKey);
                }
                return this.memoryManager.canonicalEntityKey(
                  r.canonicalEntityName || getEntityName(r) || ''
                ) === normalizedCanonicalEntityKey;
              });
            }
            if (agentFilter) {
              const filterLower = agentFilter.toLowerCase();
              filteredResults = filteredResults.filter((r: any) => {
                const payload = getContentPayload(r);
                return r.source?.toLowerCase().includes(filterLower) ||
                  payload?.agentId?.toLowerCase().includes(filterLower) ||
                  payload?.createdBy?.toLowerCase().includes(filterLower) ||
                payload?.addedBy?.toLowerCase().includes(filterLower);
              });
            }

            const preRepresentationDeduplicationCount = filteredResults.length;
            const representationDeduped = dropRedundantRepresentations(filteredResults);

            return {
              dedupMap,
              filteredResults: sortFilteredResults(representationDeduped.results),
              preRepresentationDeduplicationCount,
              redundantRepresentationCount: representationDeduped.redundantRepresentationCount,
            };
          };

          const useIndexedExact = !semanticSearch;
          const exactEntityRows = useIndexedExact ? this.memoryManager.findEntitiesByNameOrAlias(query, tenantId) : [];
          const exactEntityResults = exactEntityRows.map((row: any) =>
            rowToSearchResult(row, 'entity', { exactEntityMatch: true })
          );
          const exactObservationResults = useIndexedExact
            ? this.memoryManager.findObservationsByEntityOrAlias(query, tenantId).map((row: any) =>
                rowToSearchResult(row, 'observation', { exactObservationMatch: true })
              )
            : [];
          const exactRelationResults = useIndexedExact
            ? this.memoryManager.findRelationsByEntityOrAlias(query, tenantId).map((row: any) =>
                rowToSearchResult(row, 'relation', { exactRelationMatch: true })
              )
            : [];
          const queryExactDirectResults = [
            ...exactEntityResults,
            ...exactObservationResults,
            ...exactRelationResults,
          ];

          // An entity scope is a bounded direct-read path. It avoids a global
          // semantic search and lets callers retrieve one entity's timeline
          // even when the free-text query is not the entity name.
          const scopeQueryMatches = (result: any): boolean => {
            const normalizedQuery = String(query || '').trim().toLowerCase();
            if (
              !normalizedQuery ||
              this.memoryManager.canonicalEntityKey(normalizedQuery) === normalizedCanonicalEntityKey
            ) return true;
            const searchable = JSON.stringify(getContentPayload(result)).toLowerCase();
            const terms = normalizedQuery.split(/\s+/).filter(Boolean);
            return terms.length > 0 && terms.every((term) => searchable.includes(term));
          };
          const scopedEntityResults = normalizedCanonicalEntityKey
            ? this.memoryManager.findEntitiesByNameOrAlias(canonicalEntityKey, tenantId).map((row: any) =>
                rowToSearchResult(row, 'entity', { scopedEntityMatch: true })
              ).filter(scopeQueryMatches)
            : [];
          const scopedObservationResults = normalizedCanonicalEntityKey
            ? this.memoryManager.findObservationsByEntityOrAlias(canonicalEntityKey, tenantId).map((row: any) =>
                rowToSearchResult(row, 'observation', { scopedEntityMatch: true })
              ).filter(scopeQueryMatches)
            : [];
          const scopedRelationResults = normalizedCanonicalEntityKey
            ? this.memoryManager.findRelationsByEntityOrAlias(canonicalEntityKey, tenantId).map((row: any) =>
                rowToSearchResult(row, 'relation', { scopedEntityMatch: true })
              ).filter(scopeQueryMatches)
            : [];
          const directResultMap = new Map<string, any>();
          for (const result of [
            ...queryExactDirectResults,
            ...scopedEntityResults,
            ...scopedObservationResults,
            ...scopedRelationResults,
          ]) {
            if (!directResultMap.has(result.id)) directResultMap.set(result.id, result);
          }
          const exactDirectResults = Array.from(directResultMap.values());

          const queryExactScoredResults = scoreAndDecorate(queryExactDirectResults);
          const queryExactFiltered = dedupAndFilter(queryExactScoredResults);
          const exactScoredResults = scoreAndDecorate(exactDirectResults);
          const exactFiltered = dedupAndFilter(exactScoredResults);
          const exactAnchored = useIndexedExact && queryExactFiltered.filteredResults.length > 0;
          const exactOnly = exactSearch && exactAnchored;
          const scopedSearch = normalizedCanonicalEntityKey.length > 0;
          const semanticSkipped = exactAnchored ? 'exact_matches' : (scopedSearch ? 'entity_scope' : null);

          // Search with propagated limit (tenant-scoped). Exact graph matches are
          // prepended so "read entity X" workflows land on canonical rows first.
          // For default/hybrid searches, deterministic graph matches are enough;
          // semantic search remains available through searchType:'semantic'.
          //
          // This fallback runs ONLY when exact found nothing (exactAnchored=false),
          // and it is the broad/semantic path that can hang on a cold embedding
          // model or a huge result set. Cap it with a hard timeout so the request
          // degrades to whatever exact rows we already have instead of hanging
          // past the MCP request timeout (observed live).
          let semanticDegraded = false;
          let fallbackResults: any[] = [];
          if (!exactAnchored && !scopedSearch) {
            const SEMANTIC_TIMEOUT_MS = parseInt(process.env.SEARCH_SEMANTIC_TIMEOUT_MS || '4000', 10);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              fallbackResults = await Promise.race([
                this.memoryManager.search(query, { shared: true }, tenantId, {
                  limit: Math.max(limit + offset, Math.min(250, (limit + offset) * 3)),
                }),
                new Promise<any[]>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error(`broad search exceeded ${SEMANTIC_TIMEOUT_MS}ms`)),
                    SEMANTIC_TIMEOUT_MS
                  );
                }),
              ]);
            } catch (err) {
              semanticDegraded = true;
              console.warn(`⚠️ Broad/semantic search degraded (returning exact matches only): ${err instanceof Error ? err.message : err}`);
              fallbackResults = [];
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
          const searchResults = [
            ...exactDirectResults,
            ...fallbackResults
          ];

          // Score ALL results first, then dedup, then filter, then paginate
          const scoredResults = exactAnchored ? exactScoredResults : scoreAndDecorate(searchResults);
          const {
            dedupMap,
            filteredResults,
            preRepresentationDeduplicationCount,
            redundantRepresentationCount,
          } = exactAnchored ? exactFiltered : dedupAndFilter(scoredResults);

          const totalMatches = filteredResults.length;

          // Apply pagination: offset + limit
          const paginatedResults = filteredResults.slice(offset, offset + limit);

          // Apply compact mode + tiered content + budget enforcement
          const COMPACT_THRESHOLD = 2048; // 2KB
          let responseSize = 0;
          const budgetedResults: any[] = [];

          for (const result of paginatedResults) {
            const contentStr = JSON.stringify(result.content || {});
            const contentSize = contentStr.length;

            let outputResult: any;

            if (compact && contentSize >= COMPACT_THRESHOLD) {
              // Compact envelope for large entities
              const summary = MemoryManager.generateSummary(
                typeof result.content === 'string' ? result.content :
                result.content?.original || result.content?.content || result.content?.description || contentStr
              );
              outputResult = {
                id: result.id,
                type: result.type,
                searchScore: result.searchScore,
                sources: result.sources,
                matchedLookupKinds: result.matchedLookupKinds,
                matchOrigins: result.matchOrigins,
                name: result.canonicalEntityName || result.content?.name,
                entityType: result.entityType || result.content?.entityType || result.content?.type,
                memoryType: result.storageMemoryType || result.content?.memory_type || result.memoryType,
                agentId: result.content?.agentId || result.source,
                tags: result.content?.tags,
                relationships: result.content?.relationships,
                structuredObservation: result.structuredObservation,
                summary,
                contentSize,
                _compacted: true,
                timestamp: result.timestamp,
              };
            } else {
              // Full content for small entities or when compact=false
              outputResult = result;
            }

            const resultStr = JSON.stringify(outputResult);
            // Budget enforcement: always include at least 1 result
            if (budgetedResults.length > 0 && responseSize + resultStr.length > maxResponseSize) {
              break;
            }
            responseSize += resultStr.length;
            budgetedResults.push(outputResult);
          }

          const returnedResults = budgetedResults.length;
          const nextOffset = offset + returnedResults < totalMatches ? offset + returnedResults : null;
          const responseText = this.serializeWithTokenEstimate({
            query,
            searchType,
            totalMatches,
            returnedResults,
            nextOffset,
            responseSize,
            compact,
            exactOnly,
            exactAnchored,
            semanticSkipped,
            semanticDegraded,
            deduplicated: scoredResults.length !== dedupMap.size || redundantRepresentationCount > 0,
            preDeduplicationCount: scoredResults.length,
            preRepresentationDeduplicationCount,
            redundantRepresentationCount,
            includeRedundantRepresentations,
            sortBy: normalizedSortBy,
            canonicalEntityKey: normalizedCanonicalEntityKey || null,
            memoryTypes: Array.from(requestedMemoryTypes),
            scopedEntityMatches: scopedEntityResults.length + scopedObservationResults.length + scopedRelationResults.length,
            exactEntityMatches: exactEntityResults.length,
            exactObservationMatches: exactObservationResults.length,
            exactRelationMatches: exactRelationResults.length,
            filteredExactMatches: queryExactFiltered.filteredResults.length,
            totalResults: totalMatches,
            results: budgetedResults,
          });

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          };
        }

        case 'get_entity_detail': {
          const maxTotalSize = Number.isFinite(Number(args.maxTotalSize))
            ? Math.max(0, Math.floor(Number(args.maxTotalSize)))
            : 80000;
          const minimumDetailResponseSize = 256;
          if (maxTotalSize < minimumDetailResponseSize) {
            const errorText = JSON.stringify({
              error: 'maxTotalSize_too_small',
              minimum: minimumDetailResponseSize,
            });
            return {
              content: [{
                type: 'text',
                text: errorText.length <= maxTotalSize
                  ? errorText
                  : (maxTotalSize >= 2 ? '{}' : ''),
              }],
            };
          }
          const serializeDetailError = (payload: Record<string, any>): string => {
            const responseText = this.serializeWithTokenEstimate(payload, false);
            return responseText.length <= maxTotalSize
              ? responseText
              : JSON.stringify({ error: 'response_too_large' });
          };
          const ids = Array.isArray(args.ids)
            ? args.ids.filter((id: any) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())
            : [];
          const names = Array.isArray(args.names)
            ? args.names.filter((name: any) => typeof name === 'string' && name.trim()).map((name: string) => name.trim())
            : [];
          if (typeof args.entity === 'string' && args.entity.trim()) {
            names.push(args.entity.trim());
          }

          const requestedCount = ids.length + names.length;
          if (requestedCount === 0) {
            const responseText = serializeDetailError({
              error: 'Provide at least one storage ID (`ids`), entity name/alias (`names`), or singular `entity`.',
            });
            return { content: [{ type: 'text', text: responseText }] };
          }
          if (requestedCount > 5) {
            const responseText = serializeDetailError({ error: 'Maximum 5 combined IDs and names per request' });
            return { content: [{ type: 'text', text: responseText }] };
          }

          const retrieved: any[] = [];
          const skipped: any[] = [];
          const resolutionEntries: any[] = [];
          let budgetUsed = 0;

          const retrieveResolved = async (
            input: string,
            inputType: 'id' | 'name',
            id: string,
            matchedBy: 'id' | 'canonical_name' | 'alias' | 'normalized_name',
            canonicalName?: string
          ) => {
            const entity = await this.memoryManager.getEntityById(id, tenantId);
            if (!entity) {
              skipped.push(inputType === 'id'
                ? { id: input, reason: 'not_found' }
                : { name: input, reason: 'resolved_row_not_found', resolvedId: id });
              resolutionEntries.push({ input, inputType, status: 'not_found', id, matchedBy });
              return;
            }

            // Read-path fix: an entity row's embedded observations[] is a
            // creation-time definition snapshot — it is never updated after
            // create_entities, so serving it bare invites readers to mistake
            // it for current state (the newest non-superseded observation).
            // Attach the resolved current observation so detail readers get
            // state in the same response, and label the snapshot for what it
            // is. Non-destructive: the embedded array is preserved verbatim.
            const detailEntityName = entity.memoryType === 'entity'
              ? entity.content?.name
              : null;
            if (typeof detailEntityName === 'string' && detailEntityName.trim()) {
              try {
                const resolved = this.memoryManager.getCurrentObservation(detailEntityName, tenantId);
                entity.currentObservation = resolved?.current
                  ? {
                      id: resolved.current.id,
                      timestamp: resolved.current.timestamp,
                      addedBy: resolved.current.addedBy,
                      kind: resolved.current.kind,
                      canonicalFact: resolved.current.canonicalFact,
                      contents: resolved.current.contents,
                    }
                  : null;
              } catch {
                entity.currentObservation = null;
              }
              if (Array.isArray(entity.content?.observations) &&
                  entity.content.observations.length > 0) {
                entity.embeddedObservationsAreDefinitionSnapshot = true;
              }
            }

            const resolvedCanonicalName = canonicalName || entity.content?.name || null;
            const entityStr = JSON.stringify(entity);
            if (retrieved.length > 0 && budgetUsed + entityStr.length > maxTotalSize) {
              skipped.push({
                ...(inputType === 'id' ? { id: input } : { name: input, resolvedId: id }),
                reason: 'budget_exceeded',
                contentSize: entityStr.length,
              });
              resolutionEntries.push({
                input,
                inputType,
                status: 'resolved',
                id,
                canonicalName: resolvedCanonicalName,
                matchedBy,
                retrieved: false,
                reason: 'budget_exceeded',
              });
              return;
            }
            budgetUsed += entityStr.length;
            retrieved.push(entity);
            resolutionEntries.push({
              input,
              inputType,
              status: 'resolved',
              id,
              canonicalName: resolvedCanonicalName,
              matchedBy,
              retrieved: true,
            });
          };

          for (const id of ids) {
            await retrieveResolved(id, 'id', id, 'id');
          }

          for (const name of names) {
            const candidateRows = this.memoryManager.findEntitiesByNameOrAlias(name, tenantId);
            const candidatesById = new Map<string, {
              id: string;
              canonicalName: string | null;
              aliases: string[];
            }>();

            for (const row of candidateRows) {
              const lookupKinds = String(row.lookup_key_kinds || '')
                .split(',')
                .map((kind) => kind.trim())
                .filter(Boolean);
              if (lookupKinds.length > 0 &&
                  !lookupKinds.includes('canonical_name') &&
                  !lookupKinds.includes('alias')) {
                continue;
              }

              let content: any = {};
              try { content = JSON.parse(row.content || '{}'); } catch { content = {}; }
              candidatesById.set(row.id, {
                id: row.id,
                canonicalName: typeof content.name === 'string' ? content.name : null,
                aliases: Array.isArray(content.aliases)
                  ? content.aliases.filter((alias: any) => typeof alias === 'string')
                  : [],
              });
            }

            const candidates = Array.from(candidatesById.values());
            const comparableName = name.toLowerCase();
            const canonicalMatches = candidates.filter((candidate) =>
              candidate.canonicalName?.toLowerCase() === comparableName
            );
            const aliasMatches = candidates.filter((candidate) =>
              candidate.aliases.some((alias) => alias.toLowerCase() === comparableName)
            );
            const preferred = canonicalMatches.length > 0
              ? canonicalMatches
              : (aliasMatches.length > 0 ? aliasMatches : candidates);

            if (preferred.length === 0) {
              skipped.push({ name, reason: 'not_found' });
              resolutionEntries.push({ input: name, inputType: 'name', status: 'not_found' });
              continue;
            }
            if (preferred.length > 1) {
              const candidateIds = preferred.map((candidate) => candidate.id);
              skipped.push({ name, reason: 'ambiguous_name', candidateIds });
              resolutionEntries.push({
                input: name,
                inputType: 'name',
                status: 'ambiguous',
                candidateIds,
              });
              continue;
            }

            const candidate = preferred[0];
            const matchedBy = canonicalMatches.length === 1
              ? 'canonical_name'
              : (aliasMatches.length === 1 ? 'alias' : 'normalized_name');
            await retrieveResolved(
              name,
              'name',
              candidate.id,
              matchedBy,
              candidate.canonicalName || undefined
            );
          }

          const buildResponse = (entities: any[], entries: any[], truncatedEntities: number = 0) =>
            this.serializeWithTokenEstimate({
              retrieved: entities.length,
              skipped,
              budgetUsed,
              maxTotalSize,
              truncatedEntities,
              resolution: {
                requested: { ids, names },
                entries,
              },
              entities,
            });

          let responseText = buildResponse(retrieved, resolutionEntries);
          if (responseText.length > maxTotalSize && retrieved.length > 0) {
            const compactEntities = retrieved.map((entity) => ({
              id: entity.id,
              sourceTable: entity.sourceTable,
              type: entity.type,
              memoryType: entity.memoryType,
              source: entity.source,
              createdAt: entity.createdAt,
              content: {
                ...(entity.content?.name ? { name: entity.content.name } : {}),
                ...(entity.content?.entityName ? { entityName: entity.content.entityName } : {}),
                ...(entity.content?.entityType ? { entityType: entity.content.entityType } : {}),
                ...(entity.content?.type ? { type: entity.content.type } : {}),
              },
              contentSize: JSON.stringify(entity).length,
              _truncated: true,
            }));
            const compactIds = new Set(compactEntities.map((entity) => entity.id));
            const compactResolution = resolutionEntries.map((entry) =>
              compactIds.has(entry.id) && entry.retrieved
                ? { ...entry, truncated: true }
                : entry
            );
            responseText = buildResponse(compactEntities, compactResolution, compactEntities.length);

            while (responseText.length > maxTotalSize && compactEntities.length > 0) {
              const removed = compactEntities.pop();
              const removedEntry = compactResolution.find((entry) => entry.id === removed?.id && entry.retrieved);
              if (removedEntry) {
                removedEntry.retrieved = false;
                removedEntry.truncated = false;
                removedEntry.reason = 'budget_exceeded';
              }
              responseText = buildResponse(compactEntities, compactResolution, compactEntities.length);
            }
          }

          if (responseText.length > maxTotalSize) {
            responseText = this.serializeWithTokenEstimate({
              error: 'response_exceeds_maxTotalSize',
              maxTotalSize,
              retrieved: 0,
            }, false);
          }
          if (responseText.length > maxTotalSize) {
            responseText = JSON.stringify({ error: 'response_too_large' });
          }

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          };
        }

        case 'search_nodes': {
          // Legacy alias for graph-only search. Prefer `search_entities` with searchType:'graph'.
          const { query, limit = 50 } = args;
          const searchType = 'graph';
          const searchResults = await this.memoryManager.search(query, { shared: true }, tenantId);
          const enhancedResults = searchResults.slice(0, limit).map((result: any) => {
            const nameMatch = result.content?.name?.toLowerCase().includes(query.toLowerCase());
            const typeMatch = result.content?.type?.toLowerCase().includes(query.toLowerCase());
            const score = nameMatch ? 1.0 : typeMatch ? 0.8 : 0.6;
            const entry: any = {
              ...result,
              searchScore: score,
              searchType,
              memorySource: 'sqlite',
              semanticSimilarity: null
            };
            if (result.chunked) {
              entry.chunked = true;
              entry.contentSize = result.contentSize;
              entry.totalChunks = result.totalChunks;
            }
            return entry;
          }).sort((a: any, b: any) => b.searchScore - a.searchScore);

          // One-time deprecation log
          if (!(global as any)._deprecated_search_nodes_logged) {
            console.warn('⚠️ `search_nodes` is deprecated. Use `search_entities` with { searchType: "graph" }');
            (global as any)._deprecated_search_nodes_logged = true;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  query,
                  searchType,
                  deprecated: true,
                  totalResults: enhancedResults.length,
                  results: enhancedResults,
                }, null, 2),
              },
            ],
          };
        }

        // === INDIVIDUAL MEMORY TOOLS ===
        case 'record_learning': {
          const { context, lesson, confidence = 0.8 } = args;
          const targetAgent = args.agentId || agent;

          // NE-S6c fix: Sanitize learning content
          for (const [field, value] of [['context', context], ['lesson', lesson]] as const) {
            if (value) {
              const check = MemoryManager.sanitizeContent(value);
              if (!check.safe) {
                this.memoryManager.auditLog('record_learning', targetAgent, value, field, true, check.reason);
                this.notificationPort.send(`⚠️ Neural write flagged — agent: ${targetAgent}, operation: record_learning, reason: ${check.reason}`).catch(() => {});
                throw new Error(`Content flagged by sanitizer: ${check.reason}`);
              }
            }
          }

          await this.memoryManager.recordLearning(targetAgent, context, lesson, confidence, tenantId);
          await this.publishEventToUnified('agent.learning.recorded', { agent: targetAgent, context, lesson, confidence });
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
        }

        case 'set_preferences': {
          const targetAgent = args.agentId || agent;
          const { preferences = {} } = args;
          await this.memoryManager.updateAgentPreferences(targetAgent, preferences, tenantId);
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
        }

        case 'get_individual_memory': {
          const targetAgent = args.agentId || agent;
          const mem = this.memoryManager.getAgentMemory(targetAgent, tenantId);
          // getAgentMemory returns undefined when the agent has no snapshot.
          // JSON.stringify(undefined) === undefined (not a string), which made
          // content[0].text non-string and failed MCP response validation.
          // Return a well-formed empty-state payload instead.
          const payload = mem ?? { agentId: targetAgent, tenantId, found: false, preferences: {}, learnings: [], context: {} };
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        // === SESSION PROTOCOL TOOLS ===
        case 'get_agent_context': {
          // D4 frozen transition (sol 4320b5c5/b2543ebc): replaced by
          // resume — one bootstrap truth, no competing legacy bundle.
          throw new Error(
            "get_agent_context was replaced by 'resume' (Engram v1, TOOL-COMPATIBILITY-MAP.md): call resume({agentId, scope:{project|task}, budget}) — legacy begin_session args are auto-adapted by begin_session."
          );
        }

        case 'begin_session': {
          // Compatibility lifecycle wrapper over resume (frozen contract):
          // legacy args adapt via the PINNED adapter; handoffs are NEVER
          // auto-consumed — acking is explicit via ackHandoffIds.
          const wrapperArgs = args.scope
            ? { agentId: args.agentId, scope: args.scope, budget: args.budget ?? 4000, ackHandoffIds: args.ackHandoffIds }
            : (() => {
                const adapted = adaptLegacyBeginSessionArgs(args as any);
                return { agentId: adapted.agentId, scope: adapted.scope, budget: adapted.budget, ackHandoffIds: args.ackHandoffIds };
              })();
          const bundle = performBeginSession(
            this.memoryManager.getDb(),
            this.memoryManager as any,
            tenantId,
            wrapperArgs as any
          );
          validateEng4Output('resume', bundle); // same frozen-schema gate as resume
          this.memoryManager.auditLog('begin_session', wrapperArgs.agentId, JSON.stringify(wrapperArgs.scope), String((wrapperArgs.scope as any).project ?? (wrapperArgs.scope as any).task ?? ''));
          return { content: [{ type: 'text', text: JSON.stringify(bundle) }], structuredContent: bundle };
        }

        case 'end_session': {
          // Compatibility lifecycle wrapper over checkpoint (frozen
          // contract): checkpoint-shaped args delegate directly; legacy
          // summary/openItems callers get an explicit migration error
          // instead of a silently different write path.
          if (!args.scope || !args.state) {
            throw new Error(
              "end_session now delegates to 'checkpoint' (Engram v1, TOOL-COMPATIBILITY-MAP.md): pass {agentId, scope:{project|task}, expectedRevision, idempotencyKey, state, factChanges?, loopChanges?} — the legacy {projectId, summary, openItems} shape is retired."
            );
          }
          this._sanitizeCheckpointArgs('end_session', args, args.agentId || agent);
          const result = performEndSession(
            this.memoryManager.getDb(),
            this.memoryManager as any,
            tenantId,
            args as any
          );
          validateEng4Output('checkpoint', result);
          this.memoryManager.auditLog('end_session', args.agentId, JSON.stringify(args.scope), String((args.scope as any).project ?? (args.scope as any).task ?? ''));
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        }

        case 'add_observations': {
          const { observations } = args;

          // NE-S6c: Sanitize observation contents
          for (const obs of observations) {
            if (this.memoryManager.isConfidentialEntityReference(obs.entityName, tenantId)) {
              throw new Error('message_detail is reserved for private mailbox compatibility');
            }
            if (Array.isArray(obs.contents)) {
              for (const c of obs.contents) {
                const check = MemoryManager.sanitizeContent(c);
                if (!check.safe) {
                  this.memoryManager.auditLog('add_observation', agent, c, obs.entityName, true, check.reason);
                  this.notificationPort.send(`⚠️ Neural write flagged — agent: ${agent}, operation: add_observation, reason: ${check.reason}`).catch(() => {});
                  throw new Error(`Content flagged by sanitizer: ${check.reason}`);
                }
              }
            }
            const metadataForSanitizer = [
              obs.kind,
              obs.canonicalFact,
              obs.severity,
              ...(Array.isArray(obs.supersedes) ? obs.supersedes : []),
              ...(Array.isArray(obs.appliesTo) ? obs.appliesTo : []),
              ...(obs.metadata ? [JSON.stringify(obs.metadata)] : []),
            ].filter((value) => typeof value === 'string');
            for (const c of metadataForSanitizer) {
              const check = MemoryManager.sanitizeContent(c);
              if (!check.safe) {
                this.memoryManager.auditLog('add_observation', agent, c, obs.entityName, true, check.reason);
                this.notificationPort.send(`⚠️ Neural write flagged — agent: ${agent}, operation: add_observation, reason: ${check.reason}`).catch(() => {});
                throw new Error(`Content flagged by sanitizer: ${check.reason}`);
              }
            }
          }

          // ENG-1: mode:"replace-current" (alias supersedesLatest:true) — call-level
          // default, overridable per observation. The server resolves the entity's
          // current observation and supersedes it, so writers never fetch prior ids.
          const callLevelReplaceCurrent = args.mode === 'replace-current' || args.supersedesLatest === true;
          const wantsReplaceCurrent = (obs: any): boolean => {
            if (obs.mode === 'append' || obs.supersedesLatest === false) return false;
            return obs.mode === 'replace-current' || obs.supersedesLatest === true || callLevelReplaceCurrent;
          };

          const processObservation = async (obs: any) => {
            const contents = Array.isArray(obs.contents) ? obs.contents : [];
            const contentHashInput = contents.length === 1 && typeof contents[0] === 'string'
              ? contents[0]
              : JSON.stringify(contents);

            const replaceCurrentApplied = wantsReplaceCurrent(obs);
            let supersedesMetadata: { supersedes?: string[]; supersedeMode?: string } =
              Array.isArray(obs.supersedes) ? { supersedes: obs.supersedes } : {};
            if (replaceCurrentApplied) {
              const resolved = this.memoryManager.getCurrentObservation(obs.entityName, tenantId);
              const clientSupersedes = Array.isArray(obs.supersedes)
                ? obs.supersedes
                : (Array.isArray(obs.metadata?.supersedes) ? obs.metadata.supersedes : []);
              const merged = Array.from(new Set(
                [...clientSupersedes, ...(resolved.current?.id ? [resolved.current.id] : [])]
                  .filter((s: any) => typeof s === 'string' && s.trim())
              ));
              supersedesMetadata = {
                ...(merged.length ? { supersedes: merged } : {}),
                supersedeMode: 'replace-current',
              };
            }

            const structuredMetadata = {
              ...(obs.metadata && typeof obs.metadata === 'object' ? obs.metadata : {}),
              ...(obs.kind ? { kind: obs.kind } : {}),
              ...(obs.canonicalFact ? { canonicalFact: obs.canonicalFact } : {}),
              ...supersedesMetadata,
              ...(Array.isArray(obs.appliesTo) ? { appliesTo: obs.appliesTo } : {}),
              ...(obs.severity ? { severity: obs.severity } : {}),
            };
            const observationData = {
              entityName: obs.entityName,
              contents: obs.contents,
              addedBy: agent,
              timestamp: new Date().toISOString(),
              metadata: {
                ...structuredMetadata,
                source: 'add_observations',
                canonicalEntityKey: this.memoryManager.canonicalEntityKey(obs.entityName),
                contentHash: MemoryManager.contentHash(contentHashInput),
                vectorEmbedded: true,
                relationshipsUpdated: true
              }
            };

            const observationId = await this.memoryManager.store(agent, observationData, 'shared', 'observation', tenantId, context);

            // NE-S6b: Audit log
            this.memoryManager.auditLog('add_observation', agent, JSON.stringify(observationData), obs.entityName);

            return { id: observationId, ...observationData };
          };

          // replace-current resolves against prior writes, so those calls run
          // serially to keep same-entity supersede chains intact; plain appends
          // keep the concurrent path.
          let results: any[];
          if (observations.some(wantsReplaceCurrent)) {
            results = [];
            for (const obs of observations) {
              results.push(await processObservation(obs));
            }
          } else {
            results = await Promise.all(observations.map(processObservation));
          }

          await this.publishEventToUnified('knowledge.observations.added', {
            observations: results,
            agent: agent,
            enhancedFeatures: {
              vectorEmbeddings: 'updated',
              graphRelations: 'recomputed',
              semanticIndex: 'refreshed'
            }
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  added: results.length,
                  observations: results,
                  advancedProcessing: {
                    vectorEmbeddings: 'generated',
                    graphAnalysis: 'completed',
                    cacheInvalidation: 'smart'
                  }
                }, null, 2),
              },
            ],
          };
        }

        case 'get_current_observation': {
          const entityArg = args.entity ?? args.entityName ?? args.name;
          if (typeof entityArg !== 'string' || !entityArg.trim()) {
            const responseText = this.serializeWithTokenEstimate({
              error: 'entity is required: the entity name to resolve the current observation for (aliases accepted: entityName, name)',
              example: { entity: 'pm-loop-state' },
            });
            return {
              content: [{
                type: 'text',
                text: responseText,
              }],
            };
          }

          const result = this.memoryManager.getCurrentObservation(
            entityArg.trim(),
            tenantId,
            typeof args.windowSize === 'number' ? args.windowSize : undefined
          );
          const responseText = this.serializeWithTokenEstimate(
            result.current ? result : { ...result, reason: 'no_observations' }
          );

          return {
            content: [{
              type: 'text',
              text: responseText,
            }],
          };
        }

        case 'compact_memory': {
          const ALL_CLASSES = ['index-diet', 'superseded', 'vec-orphans', 'message-archive'];
          const mode = args.mode === 'execute' ? 'execute' : 'dry-run';
          const classes: string[] = Array.isArray(args.classes) && args.classes.length > 0
            ? args.classes.filter((c: any) => ALL_CLASSES.includes(c))
            : ALL_CLASSES;
          if (classes.length === 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: `classes must be a non-empty subset of ${JSON.stringify(ALL_CLASSES)}` }) }],
              isError: true,
            };
          }
          const olderThanDays = typeof args.olderThanDays === 'number' ? args.olderThanDays : 14;
          const spotCheckKeys: string[] = Array.isArray(args.spotCheckKeys)
            ? args.spotCheckKeys.filter((k: any) => typeof k === 'string')
            : [];

          // Execute is destructive: admin-equivalent authorization + the
          // explicit confirm key. Dry-run stays open to any authenticated key.
          if (mode === 'execute') {
            assertAgentCredentialScope(context, 'memory:admin');
            const authResult = this.memoryManager.authorizeGraphMutation('compact_memory', context);
            if (!authResult.authorized) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: authResult.reason }) }],
                isError: true,
              };
            }
            if (args.confirm !== true) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required', message: 'mode:"execute" is destructive — pass confirm:true to proceed. Run mode:"dry-run" first to review what would be reclaimed.' }) }],
                isError: true,
              };
            }
          }

          const report: any = {
            mode,
            classes,
            dbBefore: this.memoryManager.compactDbStats(),
          };

          if (classes.includes('index-diet')) {
            const analysis = this.memoryManager.compactAnalyzeIndexDiet(spotCheckKeys);
            if (mode === 'execute') {
              const rebuilt = this.memoryManager.rebuildGraphLookupIndex();
              report.indexDiet = {
                ...analysis,
                executed: true,
                rebuild: rebuilt,
                spotCheckAfter: spotCheckKeys.map((key) => ({
                  key,
                  rows: this.memoryManager.countLookupKeyRows(key),
                })),
              };
            } else {
              report.indexDiet = { ...analysis, executed: false };
            }
          }

          if (classes.includes('superseded')) {
            report.superseded = mode === 'execute'
              ? { ...(await this.memoryManager.compactExecuteSuperseded(tenantId, args.reason)), executed: true }
              : { ...this.memoryManager.compactAnalyzeSuperseded(tenantId), executed: false };
            if (report.superseded.candidates) {
              // Keep the report bounded: counts + a sample, not 640 full rows.
              const all = report.superseded.candidates;
              report.superseded = {
                ...report.superseded,
                candidateRows: all.length,
                candidateSample: all.slice(0, 10),
              };
              delete report.superseded.candidates;
            }
          }

          if (classes.includes('vec-orphans')) {
            report.vecOrphans = mode === 'execute'
              ? { ...(await this.memoryManager.compactExecuteVecOrphans()), executed: true }
              : { ...this.memoryManager.compactAnalyzeVecOrphans(), executed: false };
          }

          if (classes.includes('message-archive')) {
            report.messageArchive = mode === 'execute'
              ? { ...this.memoryManager.compactExecuteMessageArchive(tenantId, olderThanDays), executed: true }
              : { ...this.memoryManager.compactAnalyzeMessageArchive(tenantId, olderThanDays), executed: false };
          }

          if (mode === 'execute') {
            report.dbAfter = this.memoryManager.compactDbStats();
          }
          report.note = 'Deleted pages go to the freelist, not back to the OS — an offline VACUUM (container stopped) is required to shrink the file.';

          this.memoryManager.auditLog('compact_memory', agent, JSON.stringify({ mode, classes }), tenantId);

          return {
            content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
          };
        }

        case 'create_relations': {
          const { relations } = args;

          for (const relation of relations) {
            if (
              this.memoryManager.isConfidentialEntityReference(relation.from, tenantId)
              || this.memoryManager.isConfidentialEntityReference(relation.to, tenantId)
            ) {
              throw new Error('message_detail is reserved for private mailbox compatibility');
            }
          }

          const createdRelations = await Promise.all(relations.map(async (relation: any) => {
            const relationData = {
              from: relation.from,
              to: relation.to,
              relationType: relation.relationType,
              properties: relation.properties || {},
              createdBy: agent,
              timestamp: new Date().toISOString(),
              metadata: {
                graphWeight: 1.0,
                bidirectional: false,
                strength: 'medium'
              }
            };

            const relationId = await this.memoryManager.store(agent, relationData, 'shared', 'relation', tenantId, context);

            // NE-S6b: Audit log
            this.memoryManager.auditLog('create_relation', agent, JSON.stringify(relationData), `${relation.from}->${relation.to}`);

            return { id: relationId, ...relationData };
          }));

          await this.publishEventToUnified('knowledge.relations.created', {
            relations: createdRelations,
            agent: agent
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  created: createdRelations.length,
                  relations: createdRelations
                }, null, 2),
              },
            ],
          };
        }

        case 'read_graph': {
          // Read by canonical memory_type from shared_memory. Using content.type here is incorrect:
          // entity payloads use domain types (project, analysis, etc.), not the storage type 'entity'.
          const db = this.memoryManager.getDb();

          // Bounded read: page per memory_type so a broad read can never dump the whole graph.
          const rawLimit = Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 100;
          const limit = Math.max(1, Math.min(rawLimit, 500)); // hard server cap
          const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0;
          const since = typeof args.since === 'string' && args.since ? args.since : undefined;
          const includeObservations = args.includeObservations === true;
          const publicEntityPredicate = ` AND NOT (
            json_valid(content)
            AND (
              LOWER(TRIM(COALESCE(json_extract(content, '$.type'), ''))) = 'message_detail'
              OR LOWER(TRIM(COALESCE(json_extract(content, '$.entityType'), ''))) = 'message_detail'
              OR LOWER(TRIM(COALESCE(json_extract(content, '$.memoryType'), ''))) = 'message_detail'
              OR LOWER(TRIM(COALESCE(json_extract(content, '$.memory_type'), ''))) = 'message_detail'
            )
          )`;

          const toEntry = (row: any) => {
            let content: any = {};
            try {
              content = JSON.parse(row.content || '{}');
            } catch {
              content = { raw: row.content, parseError: true };
            }
            return {
              id: row.id,
              type: 'shared',
              content,
              relevance: 0.6,
              source: row.created_by,
              timestamp: new Date(row.created_at),
            };
          };

          const publicPageFor = (memType: string): { total: number; rows: any[] } => {
            try {
              let q = `SELECT id, memory_type, content, created_by, created_at FROM shared_memory WHERE tenant_id = ? AND memory_type = ?`;
              const p: any[] = [tenantId, memType];
              if (memType === 'entity') q += publicEntityPredicate;
              if (since) { q += ' AND created_at >= ?'; p.push(since); }
              q += ' ORDER BY created_at DESC';

              // Confidential rows must be removed before applying the public
              // offset and before calculating totals. SQL-level discriminator
              // filters cannot recognize corrupt project-typed msg-detail-*
              // entities, aliases, or materialized child references. Iterate
              // rather than loading the whole graph, retaining only one public
              // response page while calculating honest public counts.
              const rows: any[] = [];
              let total = 0;
              const iterator = db.prepare(q).iterate(...p) as IterableIterator<any>;
              for (const rawRow of iterator) {
                if (this.memoryManager.isConfidentialGraphRow(memType, rawRow.content, tenantId)) {
                  continue;
                }
                const entry = toEntry(rawRow);
                if (total >= offset && rows.length < limit) rows.push(entry);
                total++;
              }
              return { total, rows };
            } catch {
              return { total: 0, rows: [] };
            }
          };

          const entityPage = publicPageFor('entity');
          const relationPage = publicPageFor('relation');
          const observationPage = publicPageFor('observation');
          const entityTotal = entityPage.total;
          const relationTotal = relationPage.total;
          const observationTotal = observationPage.total;

          const entitiesOnly = entityPage.rows;
          const relationsOnly = relationPage.rows;
          const observationsOnly = includeObservations ? observationPage.rows : [];

          const pageEnd = offset + limit;
          const graphData: any = {
            timestamp: new Date().toISOString(),
            statistics: {
              nodeCount: entityTotal,
              edgeCount: relationTotal,
              observationCount: observationTotal,
              returned: {
                entities: entitiesOnly.length,
                relations: relationsOnly.length,
                observations: observationsOnly.length,
              },
            },
            pagination: {
              limit,
              offset,
              since: since || null,
              includeObservations,
              nextOffset: {
                entities: pageEnd < entityTotal ? pageEnd : null,
                relations: pageEnd < relationTotal ? pageEnd : null,
                observations: includeObservations && pageEnd < observationTotal ? pageEnd : null,
              },
            },
            graph: {
              entities: entitiesOnly,
              relations: relationsOnly,
              observations: observationsOnly
            }
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(graphData, null, 2),
              },
            ],
          };
        }

        case 'get_entity_neighborhood': {
          // Bounded local-graph around one entity (the safe, focused alternative to read_graph).
          const db = this.memoryManager.getDb();
          const entityName = typeof args.entity === 'string' && args.entity
            ? args.entity
            : (typeof args.entityName === 'string' ? args.entityName : '');
          if (!entityName) {
            throw new Error('Missing required field: `entity` (the center entity name)');
          }
          const maxHops = Math.max(1, Math.min(Number(args.depth) || 1, 2));
          const cap = Math.max(1, Math.min(Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 50, 200));
          const includeObservations = args.includeObservations === true;

          const getEntityRow = (name: string): any => {
            try {
              const row = db.prepare(
                `SELECT id, content, created_at FROM shared_memory
                 WHERE tenant_id = ? AND memory_type = 'entity' AND json_valid(content)
                   AND json_extract(content, '$.name') = ?
                 LIMIT 1`
              ).get(tenantId, name);
              if (!row) return undefined;
              let content: any;
              try { content = JSON.parse((row as any).content || '{}'); } catch { return undefined; }
              return this.memoryManager.isConfidentialMessageSearchItem('entity', content)
                ? undefined
                : row;
            } catch {
              return undefined;
            }
          };
          const obsCountFor = (name: string): number => {
            try {
              const rows = db.prepare(
                `SELECT content FROM shared_memory
                 WHERE tenant_id = ? AND memory_type = 'observation' AND json_valid(content)
                   AND json_extract(content, '$.entityName') = ?`
              ).all(tenantId, name) as Array<{ content: string }>;
              return rows.filter((row) =>
                !this.memoryManager.isConfidentialGraphRow('observation', row.content, tenantId)
              ).length;
            } catch {
              return 0;
            }
          };

          const centerRow = getEntityRow(entityName);
          if (!centerRow) {
            const responseText = this.serializeWithTokenEstimate({
              entity: entityName, found: false, center: null, nodes: [], edges: [],
              statistics: { depth: maxHops, nodeCount: 0, edgeCount: 0 },
              truncated: { nodes: false, edges: false },
            });
            return {
              content: [{
                type: 'text',
                text: responseText,
              }],
            };
          }
          let centerContent: any = {};
          try { centerContent = JSON.parse(centerRow.content || '{}'); } catch { centerContent = {}; }
          const centerName = centerContent.name || entityName;

          const nodeMap = new Map<string, any>();
          const edges: any[] = [];
          const edgeSeen = new Set<string>();
          let nodesTrunc = false;
          let edgesTrunc = false;
          const visited = new Set<string>([centerName]);
          let frontier: string[] = [centerName];

          for (let hop = 1; hop <= maxHops; hop++) {
            const next: string[] = [];
            for (const nm of frontier) {
              let rels: any[] = [];
              try {
                rels = (db.prepare(
                  `SELECT content FROM shared_memory
                   WHERE tenant_id = ? AND memory_type = 'relation'
                   AND json_valid(content)
                   AND (json_extract(content, '$.from') = ? OR json_extract(content, '$.to') = ?)
                   LIMIT ?`
                ).all(tenantId, nm, nm, cap) as any[]).filter((row: any) =>
                  !this.memoryManager.isConfidentialGraphRow('relation', row.content, tenantId)
                );
              } catch {
                rels = [];
              }
              for (const r of rels) {
                let c: any;
                try { c = JSON.parse(r.content); } catch { continue; }
                const from = c.from, to = c.to, rt = c.relationType;
                if (!from || !to) continue;
                const key = `${from}|${to}|${rt}`;
                if (!edgeSeen.has(key)) {
                  if (edges.length >= cap) { edgesTrunc = true; }
                  else { edgeSeen.add(key); edges.push({ source: from, target: to, relationType: rt }); }
                }
                const other = from === nm ? to : (to === nm ? from : null);
                if (other && !visited.has(other)) {
                  visited.add(other);
                  if (nodeMap.size >= cap) { nodesTrunc = true; }
                  else {
                    const erow = getEntityRow(other);
                    let ec: any = {};
                    if (erow) { try { ec = JSON.parse(erow.content || '{}'); } catch { ec = {}; } }
                    nodeMap.set(other, {
                      id: erow?.id || null,
                      name: other,
                      entityType: ec.entityType || ec.type || null,
                      observationCount: obsCountFor(other),
                      hop,
                      exists: !!erow,
                    });
                    next.push(other);
                  }
                }
              }
              if (edges.length >= cap) { edgesTrunc = true; break; }
            }
            frontier = next;
            if (!frontier.length) break;
          }

          let observations: any[] | undefined;
          if (includeObservations) {
            try {
              const allObs = db.prepare(
                `SELECT id, content, created_at FROM shared_memory
                 WHERE tenant_id = ? AND memory_type = 'observation' AND json_valid(content)
                   AND json_extract(content, '$.entityName') = ?
                 ORDER BY created_at DESC LIMIT ?`
              ).all(tenantId, centerName, cap) as any[];
              observations = allObs.map((row: any) => {
                let content: any = {};
                try { content = JSON.parse(row.content || '{}'); } catch { content = { raw: row.content, parseError: true }; }
                return { id: row.id, content, timestamp: new Date(row.created_at) };
              }).filter((entry: any) =>
                !this.memoryManager.isConfidentialGraphRow('observation', entry.content, tenantId)
              );
            } catch {
              observations = [];
            }
          }

          const neighborhood: any = {
            entity: centerName,
            found: true,
            depth: maxHops,
            limit: cap,
            center: {
              id: centerRow.id,
              name: centerName,
              entityType: centerContent.entityType || centerContent.type || null,
              observationCount: obsCountFor(centerName),
            },
            nodes: Array.from(nodeMap.values()),
            edges,
            ...(includeObservations ? { observations } : {}),
            statistics: {
              depth: maxHops,
              nodeCount: nodeMap.size,
              edgeCount: edges.length,
              ...(includeObservations ? { observationCount: observations?.length || 0 } : {}),
            },
            truncated: { nodes: nodesTrunc, edges: edgesTrunc },
          };
          const responseText = this.serializeWithTokenEstimate(neighborhood);

          return {
            content: [{ type: 'text', text: responseText }],
          };
        }

        case 'get_entity_backlinks': {
          const db = this.memoryManager.getDb();
          const entityName = typeof args.entity === 'string' && args.entity
            ? args.entity
            : (typeof args.entityName === 'string' ? args.entityName : '');
          if (!entityName) {
            throw new Error('Missing required field: `entity` (the target entity name)');
          }
          const cap = Math.max(1, Math.min(Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 50, 200));
          const includeOutgoing = args.includeOutgoing === true;

          let entityRow = db.prepare(
            `SELECT id, content, created_at FROM shared_memory
             WHERE tenant_id = ? AND memory_type = 'entity' AND json_valid(content)
               AND LOWER(json_extract(content, '$.name')) = LOWER(?)
             LIMIT 1`
          ).get(tenantId, entityName) as any | undefined;

          let entityContent: any = {};
          if (entityRow) {
            try { entityContent = JSON.parse(entityRow.content || '{}'); } catch { entityContent = {}; }
            if (this.memoryManager.isConfidentialMessageSearchItem('entity', entityContent)) {
              entityRow = undefined;
              entityContent = {};
            }
          }
          const canonicalName = entityContent.name || entityName;

          const incomingRows = (db.prepare(
            `SELECT id, content, created_by, created_at FROM shared_memory
             WHERE tenant_id = ? AND memory_type = 'relation' AND json_valid(content)
               AND LOWER(json_extract(content, '$.to')) = LOWER(?)
             ORDER BY created_at DESC LIMIT ?`
          ).all(tenantId, canonicalName, cap) as any[]).filter((row: any) =>
            !this.memoryManager.isConfidentialGraphRow('relation', row.content, tenantId)
          );
          const outgoingRows = includeOutgoing ? (db.prepare(
            `SELECT id, content, created_by, created_at FROM shared_memory
             WHERE tenant_id = ? AND memory_type = 'relation' AND json_valid(content)
               AND LOWER(json_extract(content, '$.from')) = LOWER(?)
             ORDER BY created_at DESC LIMIT ?`
          ).all(tenantId, canonicalName, cap) as any[]).filter((row: any) =>
            !this.memoryManager.isConfidentialGraphRow('relation', row.content, tenantId)
          ) : [];

          const parseRelation = (row: any) => {
            let content: any = {};
            try { content = JSON.parse(row.content || '{}'); } catch { content = { raw: row.content, parseError: true }; }
            return {
              id: row.id,
              from: content.from,
              to: content.to,
              relationType: content.relationType,
              properties: content.properties || {},
              source: row.created_by,
              timestamp: new Date(row.created_at),
            };
          };

          const incoming = incomingRows.map(parseRelation);
          const outgoing = outgoingRows.map(parseRelation);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                entity: canonicalName,
                found: !!entityRow,
                limit: cap,
                backlinks: incoming,
                ...(includeOutgoing ? { outgoing } : {}),
                statistics: {
                  backlinks: incoming.length,
                  ...(includeOutgoing ? { outgoing: outgoing.length } : {}),
                },
                truncated: {
                  backlinks: incoming.length >= cap,
                  ...(includeOutgoing ? { outgoing: outgoing.length >= cap } : {}),
                },
              }, null, 2),
            }],
          };
        }

        // === AI AGENT COMMUNICATION ===
        case 'send_ai_message': {
          // Avoid conflating sender and target: support `to`/`from` and aliases
          const explicitTarget = args.to || args.agentId; // agentId kept for backward compatibility
          const requestedSenderAgentId = args.from || this.agentId;
          if (!args.from) {
            console.warn(`⚠️ send_ai_message called without 'from' — attributing to server. Callers should always pass 'from'.`);
          }
          const senderAgentId = this.memoryManager.resolveMailboxAddress(requestedSenderAgentId, tenantId);
          if (!senderAgentId) {
            throw new Error('Sender identity is invalid');
          }
          const content = args.content ?? args.message;
          const messageType = args.messageType ?? 'info';
          const priority = args.priority ?? 'normal';
          const broadcast = args.broadcast === true || explicitTarget === '*';
          const excludeSelf = args.excludeSelf !== false; // default true
          const capSelector: string[] | undefined = args.toCapabilities || args.capabilities;

          if (typeof content !== 'string' || !content) {
            throw new Error('Missing required field: `content` (or `message` alias)');
          }
          if (!['info', 'task', 'query', 'response', 'collaboration'].includes(messageType)) {
            throw new Error('Invalid message type');
          }
          if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
            throw new Error('Invalid message priority');
          }

          // NE-S6c: Sanitize message content
          const msgSanitize = MemoryManager.sanitizeContent(content);
          if (!msgSanitize.safe) {
            this.memoryManager.auditLog('send_ai_message', senderAgentId, content, explicitTarget, true, msgSanitize.reason);
            this.notificationPort.send(`⚠️ Neural write flagged — agent: ${senderAgentId}, operation: send_ai_message, reason: ${msgSanitize.reason}`).catch(() => {});
            throw new Error(`Content flagged by sanitizer: ${msgSanitize.reason}`);
          }

          // Resolve recipients
          let recipients: string[] = [];
          if (!broadcast && explicitTarget) {
            const resolvedTarget = this.memoryManager.resolveMailboxAddress(explicitTarget, tenantId);
            if (!resolvedTarget) {
              throw new Error('Recipient identity is invalid');
            }
            recipients = [resolvedTarget];
          } else if (broadcast) {
            const rows = this.memoryManager.getDb().prepare(
              `SELECT agent_id, metadata_json
               FROM agent_registrations
               WHERE tenant_id = ? AND status = 'active'`
            ).all(tenantId) as any[];
            recipients = rows
              .filter((row: any) => effectiveRegistrationStatus(
                'active',
                parseRegistrationJson(row.metadata_json, {})
              ) === 'active')
              .map((row: any) => row.agent_id)
              .filter((id: any) => typeof id === 'string' && id.length > 0)
              .map((id: string) => this.memoryManager.resolveMailboxAddress(id, tenantId));
            if (excludeSelf) recipients = recipients.filter(id => id !== senderAgentId);
          } else if (capSelector && capSelector.length > 0) {
            const want = capSelector.map((c: string) => String(c).toLowerCase());
            const rows = this.memoryManager.getDb().prepare(
              `SELECT agent_id, capabilities_json, metadata_json
               FROM agent_registrations
               WHERE tenant_id = ? AND status = 'active'`
            ).all(tenantId) as any[];
            recipients = rows
              .filter((row: any) => effectiveRegistrationStatus(
                'active',
                parseRegistrationJson(row.metadata_json, {})
              ) === 'active')
              .filter((row: any) => {
                const parsedCapabilities = parseRegistrationJson(row.capabilities_json, []);
                const caps = (Array.isArray(parsedCapabilities) ? parsedCapabilities : [])
                  .map((c: any) => String(c).toLowerCase());
                return want.every(w => caps.includes(w));
              })
              .map((row: any) => row.agent_id)
              .filter((id: any) => typeof id === 'string' && id.length > 0)
              .map((id: string) => this.memoryManager.resolveMailboxAddress(id, tenantId));
            if (excludeSelf) recipients = recipients.filter(id => id !== senderAgentId);
          } else {
            throw new Error('Missing recipient: provide `to`, `broadcast: true`, or `toCapabilities`.');
          }

          // De-duplicate recipients
          recipients = Array.from(new Set(recipients.filter(Boolean)));

          const results: { to: string; messageId: string; deliveryStatus: 'queued' | 'delivered'; clientsNotified: number }[] = [];

          for (const targetAgentId of recipients) {
            const messageData = {
              from: senderAgentId,
              to: targetAgentId,
              content,
              messageType,
              priority,
              timestamp: new Date().toISOString(),
              deliveryStatus: 'queued',
              tenantId,
              metadata: {
                original: {
                  requestedFrom: requestedSenderAgentId,
                  requestedTo: explicitTarget || null,
                }
              }
            };

            const messageId = await this.memoryManager.storeMessage(
              senderAgentId,
              targetAgentId,
              content,
              messageType,
              priority,
              messageData.metadata,
              tenantId,
              context,
              Array.isArray(args.supersedes) ? args.supersedes : []
            );
            // NE-S6b: Audit log
            this.memoryManager.auditLog('send_ai_message', senderAgentId, content, targetAgentId);

            const delivery = await this.simulateRealTimeDelivery(messageData, messageId);
            results.push({ to: targetAgentId, messageId, ...delivery });

            await this.publishEventToUnified('ai.message.sent', {
              messageId,
              from: senderAgentId,
              to: targetAgentId,
              messageType,
              priority,
              realTimeDelivered: delivery.deliveryStatus === 'delivered',
              clientsNotified: delivery.clientsNotified,
            });
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: results.length > 0 ? 'sent' : 'no_recipients',
                  recipients: recipients,
                  sentCount: results.length,
                  messageIds: results,
                  selection: {
                    mode: broadcast ? 'broadcast' : (capSelector?.length ? 'capabilities' : 'direct'),
                    capabilities: capSelector || [],
                    excludeSelf
                  },
                  delivery: {
                    persisted: results.length,
                    delivered: results.filter((result) => result.deliveryStatus === 'delivered').length,
                    queued: results.filter((result) => result.deliveryStatus === 'queued').length,
                    clientsNotified: results.reduce((sum, result) => sum + result.clientsNotified, 0),
                  }
                }, null, 2),
              },
            ],
          };
        }

        case 'get_ai_messages': {
          const { agentId: targetAgentId, messageType, since, markAsRead, includeArchived, includeSuperseded, from } = args;
          if (!targetAgentId || this.memoryManager.resolveMailboxAddress(targetAgentId, tenantId) !== targetAgentId) {
            throw new Error('Agent identity is invalid');
          }
          if (from && this.memoryManager.resolveMailboxAddress(from, tenantId) !== from) {
            throw new Error('Sender filter identity is invalid');
          }
          const compact = args.compact !== false; // default true
          const unreadOnly = args.unreadOnly !== false; // default true
          // Server-side hard cap: 20 messages max, floor of 1
          const requestedLimit = Number(args.limit ?? 5);
          const requestedOffset = Number(args.offset ?? 0);
          const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(Math.floor(requestedLimit), 20))
            : 5;
          const offset = Number.isFinite(requestedOffset)
            ? Math.max(0, Math.floor(requestedOffset))
            : 0;

          // P1: Use dedicated ai_messages table with indexed queries (tenant-scoped)
          const page = this.memoryManager.getMessagesPage(targetAgentId, {
            messageType,
            since,
            limit,
            offset,
            unreadOnly,
            markAsRead,
            tenantId,
            includeArchived,
            includeSuperseded,
            compact,
            from,
          });
          const rawMessages = page.messages;

          // Transform to response format — compact mode omits full content
          const formattedMessages = rawMessages.map((msg: any) => {
            const msgMeta = msg.metadata ? (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) : {};
            const base: any = {
              id: msg.id,
              type: 'shared',
              content: {
                from: msg.from_agent,
                to: msg.to_agent,
                messageType: msg.message_type,
                priority: msg.priority,
                timestamp: msg.created_at,
                deliveryStatus: this.messageDeliveryStatus(msg, msgMeta),
                ...(msg.superseded_by ? { supersededBy: msg.superseded_by, supersededAt: msg.superseded_at } : {}),
              },
              relevance: 0.6,
              source: msg.from_agent,
              timestamp: msg.created_at,
            };
            if (compact) {
              // Summary only — agent uses get_message_detail for full content
              base.content.summary = msg.summary || MemoryManager.generateSummary(msg.content || '');
            } else {
              base.content.content = msg.content;
              base.content.metadata = msg.metadata ? JSON.parse(msg.metadata)?.original || msg.metadata : {};
            }
            return base;
          });
          const mutatingUnreadPage = markAsRead === true && unreadOnly;
          const hasMore = mutatingUnreadPage
            ? page.totalMatching > formattedMessages.length
            : page.offset + formattedMessages.length < page.totalMatching;
          const nextOffset = hasMore
            ? (mutatingUnreadPage ? 0 : page.offset + formattedMessages.length)
            : null;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  agentId: targetAgentId,
                  totalMessages: page.totalMatching,
                  returnedMessages: formattedMessages.length,
                  hasMore,
                  nextOffset,
                  compact,
                  hint: compact ? 'Use get_message_detail(messageId) for full content' : undefined,
                  filters: {
                    messageType: messageType || 'all',
                    since: since || 'beginning',
                    unreadOnly,
                    includeSuperseded: includeSuperseded === true,
                    from: from || undefined,
                    limit: page.limit,
                    offset: page.offset,
                    includeArchived: includeArchived === true,
                  },
                  messages: formattedMessages,
                  metadata: {
                    returnedAt: new Date().toISOString(),
                  }
                }, null, 2),
              },
            ],
          };
        }

        // === MESSAGE DETAIL (Message Hygiene) ===
        case 'get_message_detail': {
          const { messageId: detailMsgId, agentId: detailAgentId } = args;
          const detailMarkRead = args.markAsRead !== false; // default true

          if (!detailMsgId) {
            throw new Error('Missing required field: messageId');
          }
          if (!detailAgentId) {
            throw new Error('Missing required field: agentId (recipient identity required)');
          }
          if (this.memoryManager.resolveMailboxAddress(detailAgentId, tenantId) !== detailAgentId) {
            throw new Error('Agent identity is invalid');
          }

          // Tenant + agent scoping to prevent cross-boundary reads
          const msg = await this.memoryManager.getMessageById(detailMsgId, detailAgentId, detailMarkRead, tenantId);
          if (!msg) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Message not found', messageId: detailMsgId }) }],
              isError: true,
            };
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: msg.id,
                from: msg.from_agent,
                to: msg.to_agent,
                content: msg.content,
                messageType: msg.message_type,
                priority: msg.priority,
                timestamp: msg.created_at,
                deliveryStatus: this.messageDeliveryStatus(msg, msg.metadata ? JSON.parse(msg.metadata) : {}),
                readAt: msg.read_at,
                summary: msg.summary,
                metadata: msg.metadata ? JSON.parse(msg.metadata) : {},
              }, null, 2),
            }],
          };
        }

        // === USER PROFILE (Task 1100) ===
        case 'get_user_profile': {
          const { userId: profileUserId } = args;

          // Enforce userId ownership for JWT callers (authType === 'jwt')
          if (context.authType === 'jwt' && context.userId && profileUserId !== context.userId) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Forbidden', code: 'USER_ID_MISMATCH', message: 'JWT callers cannot access other users profiles' }) }],
              isError: true,
            };
          }

          const profile = this.memoryManager.getUserProfile(profileUserId, tenantId);
          if (!profile) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Not Found', message: `User ${profileUserId} not found in tenant ${tenantId}` }) }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }]
          };
        }

        case 'update_user_profile': {
          const { userId: updateUserId, displayName, timezone, locale, dateFormat, units, workingHours } = args;

          // Enforce userId ownership for JWT callers
          if (context.authType === 'jwt' && context.userId && updateUserId !== context.userId) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Forbidden', code: 'USER_ID_MISMATCH', message: 'JWT callers cannot modify other users profiles' }) }],
              isError: true,
            };
          }

          const updatedProfile = this.memoryManager.updateUserProfile(
            updateUserId,
            { displayName, timezone, locale, dateFormat, units, workingHours },
            tenantId
          );

          if (!updatedProfile) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Not Found', message: `User ${updateUserId} not found in tenant ${tenantId}` }) }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'updated', profile: updatedProfile }, null, 2) }]
          };
        }

        // === MESSAGE LIFECYCLE (Task 1200) ===
        case 'mark_messages_read': {
          const { agentId: markAgentId, messageIds } = args;
          if (!markAgentId || this.memoryManager.resolveMailboxAddress(markAgentId, tenantId) !== markAgentId) {
            throw new Error('Agent identity is invalid');
          }
          const markedCount = this.memoryManager.markMessagesRead(markAgentId, messageIds, tenantId);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                agentId: markAgentId,
                markedAsRead: markedCount,
                scope: messageIds ? 'specific' : 'all_unread',
              }, null, 2)
            }]
          };
        }

        case 'archive_messages': {
          const { agentId: archiveAgentId, olderThanDays, messageIds: archiveIds, markAsRead } = args;
          if (!archiveAgentId || this.memoryManager.resolveMailboxAddress(archiveAgentId, tenantId) !== archiveAgentId) {
            throw new Error('Agent identity is invalid');
          }
          const byId = Array.isArray(archiveIds) && archiveIds.length > 0;
          const archiveResult = this.memoryManager.archiveMessagesDetailed(
            archiveAgentId,
            byId ? undefined : (olderThanDays ?? 30),
            tenantId,
            byId ? archiveIds : undefined,
            markAsRead === true
          );
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                agentId: archiveAgentId,
                archived: archiveResult.archived,
                markedAsRead: archiveResult.markedAsRead,
                remainingUnarchived: archiveResult.remainingUnarchived,
                remainingUnread: archiveResult.remainingUnread,
                scope: byId ? 'specific' : 'older_than_days',
                markAsRead: markAsRead === true,
                ...(byId ? { messageIds: archiveIds } : { olderThanDays: olderThanDays ?? 30 }),
              }, null, 2)
            }]
          };
        }

        case 'register_agent': {
          const { agentId: newAgentId, name, capabilities, endpoint } = args;
          if (!newAgentId || this.memoryManager.resolveMailboxAddress(newAgentId, tenantId) !== newAgentId) {
            throw new Error('agentId must be a valid exact agent identifier');
          }
          const metadata = args.metadata && typeof args.metadata === 'object' ? args.metadata : {};
          const capabilityList = Array.isArray(capabilities) ? capabilities : [];
          const ttlSeconds = typeof args.ttlSeconds === 'undefined' || args.ttlSeconds === null
            ? undefined
            : Number(args.ttlSeconds);
          if (typeof ttlSeconds !== 'undefined' && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
            throw new Error('ttlSeconds must be a positive number when provided');
          }

          const now = new Date().toISOString();
          let expiresAt: string | undefined;
          if (typeof args.expiresAt === 'string' && args.expiresAt.trim()) {
            const expiresMs = Date.parse(args.expiresAt);
            if (!Number.isFinite(expiresMs)) {
              throw new Error('expiresAt must be a valid ISO timestamp when provided');
            }
            expiresAt = new Date(expiresMs).toISOString();
          } else if (ttlSeconds) {
            expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
          }

          const canonicalAgentId = this.memoryManager.inferCanonicalAgentId(newAgentId, name, metadata);
          const aliases = Array.from(new Set([
            canonicalAgentId,
            newAgentId,
            ...(Array.isArray(metadata.aliases) ? metadata.aliases : []),
          ].filter(Boolean).map((value: string) => String(value).trim().toLowerCase())));
          const enrichedMetadata = {
            ...metadata,
            canonicalAgentId,
            aliases,
            registeredBy: agent,
            registrationTime: now,
            lastSeen: now,
            ...(ttlSeconds ? { ttlSeconds } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            status: 'active',
            lifecycleStatus: 'active',
            version: HYTHE_VERSION
          };

          // Upsert into canonical agent_registrations table
          const db = this.memoryManager.getDb();
          db.prepare(`
            INSERT INTO agent_registrations (agent_id, tenant_id, name, capabilities_json, endpoint, metadata_json, status, registered_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(agent_id, tenant_id) DO UPDATE SET
              name = excluded.name,
              capabilities_json = excluded.capabilities_json,
              endpoint = excluded.endpoint,
              metadata_json = excluded.metadata_json,
              status = 'active',
              registered_by = excluded.registered_by,
              updated_at = excluded.updated_at
          `).run(
            newAgentId,
            tenantId,
            name,
            JSON.stringify(capabilityList),
            endpoint || null,
            JSON.stringify(enrichedMetadata),
            agent,
            now,
            now
          );

          const registrationId = `reg-${newAgentId}-${tenantId}`;

          // Simulate agent registration with unified server
          const agentData = { agentId: newAgentId, name, capabilities: capabilityList, endpoint, metadata: enrichedMetadata };
          await this.simulateAgentRegistration(agentData);

          await this.publishEventToUnified('agent.registered', {
            registrationId,
            agentId: newAgentId,
            name,
            capabilities: capabilityList,
            registeredBy: agent
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  registrationId,
                  agentId: newAgentId,
                  canonicalAgentId,
                  aliases,
                  status: 'registered',
                  lifecycleStatus: 'active',
                  expiresAt,
                  ttlSeconds,
                  features: {
                    crossPlatformAccess: true,
                    realTimeMessaging: true,
                    autonomousCapability: capabilityList.includes('autonomous'),
                    multiProviderAI: capabilityList.includes('multi-provider')
                  }
                }, null, 2),
              },
            ],
          };
        }

        case 'unregister_agent': {
          const targetAgentId = typeof args.agentId === 'string' ? args.agentId : '';
          if (!targetAgentId || this.memoryManager.resolveMailboxAddress(targetAgentId, tenantId) !== targetAgentId) {
            throw new Error('agentId must be a valid exact agent identifier');
          }

          const now = new Date().toISOString();
          const db = this.memoryManager.getDb();
          const row = db.prepare(
            `SELECT agent_id, name, metadata_json, status, updated_at
             FROM agent_registrations
             WHERE tenant_id = ? AND agent_id = ?
             LIMIT 1`
          ).get(tenantId, targetAgentId) as any;

          if (!row) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'not_found',
                  agentId: targetAgentId,
                }, null, 2),
              }],
            };
          }

          const metadata = parseRegistrationJson(row.metadata_json, {});
          const updatedMetadata = {
            ...metadata,
            status: 'inactive',
            lifecycleStatus: 'inactive',
            unregisteredAt: now,
            unregisteredBy: registrationActor,
            ...(args.reason ? { unregisterReason: String(args.reason) } : {}),
          };

          db.prepare(
            `UPDATE agent_registrations
             SET status = 'inactive',
                 metadata_json = ?,
                 updated_at = ?
             WHERE tenant_id = ? AND agent_id = ?`
          ).run(JSON.stringify(updatedMetadata), now, tenantId, targetAgentId);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'unregistered',
                agentId: targetAgentId,
                previousStatus: row.status,
                lifecycleStatus: 'inactive',
                unregisteredAt: now,
              }, null, 2),
            }],
          };
        }

        case 'gc_agent_registrations': {
          const dryRun = args.dryRun !== false;
          const deleteExpired = args.deleteExpired !== false;
          const inactiveOlderThanSeconds = typeof args.inactiveOlderThanSeconds === 'undefined' || args.inactiveOlderThanSeconds === null
            ? undefined
            : Number(args.inactiveOlderThanSeconds);
          if (typeof inactiveOlderThanSeconds !== 'undefined' && (!Number.isFinite(inactiveOlderThanSeconds) || inactiveOlderThanSeconds < 0)) {
            throw new Error('inactiveOlderThanSeconds must be a non-negative number when provided');
          }
          const gcLimit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
          const nowMs = Date.now();
          const db = this.memoryManager.getDb();
          const rows = db.prepare(
            `SELECT agent_id, name, metadata_json, status, updated_at, created_at
             FROM agent_registrations
             WHERE tenant_id = ?
             ORDER BY updated_at ASC`
          ).all(tenantId) as any[];

          const candidates = rows.flatMap((row) => {
            const metadata = parseRegistrationJson(row.metadata_json, {});
            const reasons: string[] = [];
            const expiresAt = registrationExpiresAt(metadata);
            if (deleteExpired && expiresAt && Date.parse(expiresAt) <= nowMs) {
              reasons.push('expired');
            }
            if (typeof inactiveOlderThanSeconds !== 'undefined' && row.status !== 'active') {
              const lastUpdatedMs = Date.parse(row.updated_at || row.created_at || '');
              if (Number.isFinite(lastUpdatedMs) && nowMs - lastUpdatedMs >= inactiveOlderThanSeconds * 1000) {
                reasons.push('inactive_stale');
              }
            }
            if (reasons.length === 0) return [];
            return [{
              agentId: row.agent_id,
              name: row.name,
              status: effectiveRegistrationStatus(row.status, metadata, nowMs),
              storedStatus: row.status,
              updatedAt: row.updated_at,
              expiresAt,
              reasons,
            }];
          }).slice(0, gcLimit);

          let deleted = 0;
          if (!dryRun && candidates.length > 0) {
            const remove = db.prepare(
              `DELETE FROM agent_registrations
               WHERE tenant_id = ? AND agent_id = ?`
            );
            const deleteBatch = db.transaction(() => {
              for (const candidate of candidates) {
                deleted += remove.run(tenantId, candidate.agentId).changes;
              }
            });
            deleteBatch();
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: dryRun ? 'dry_run' : 'deleted',
                dryRun,
                matched: candidates.length,
                deleted,
                limit: gcLimit,
                criteria: {
                  deleteExpired,
                  inactiveOlderThanSeconds,
                },
                candidates,
              }, null, 2),
            }],
          };
        }

        case 'set_agent_identity': {
          throw new Error(
            'set_agent_identity is temporarily disabled while HYTHE migrates to tenant-scoped stable principals; use register_agent for an exact handle without mailbox-history transfer.'
          );
        }

        case 'get_agent_status': {
          const { agentId: targetAgentId, groupByCanonical = true } = args;
          const statusLimit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
          const statusOffset = Math.max(0, Number(args.offset) || 0);

          let statusData;
          const db = this.memoryManager.getDb();

          if (targetAgentId) {
            const row = db.prepare(
              `SELECT agent_id, name, capabilities_json, metadata_json, status, created_at, updated_at
               FROM agent_registrations
               WHERE tenant_id = ? AND agent_id = ?
               LIMIT 1`
            ).get(tenantId, targetAgentId) as any;

            const metadata = row ? parseRegistrationJson(row.metadata_json, {}) : {};
            const canonicalAgentId = row
              ? this.memoryManager.inferCanonicalAgentId(row.agent_id, row.name, metadata)
              : this.memoryManager.resolvePreferredAgentId(targetAgentId, tenantId);
            const expiresAt = registrationExpiresAt(metadata);

            statusData = {
              agentId: targetAgentId,
              canonicalAgentId,
              status: row ? effectiveRegistrationStatus(row.status, metadata) : 'unknown',
              storedStatus: row?.status,
              lastSeen: row?.updated_at || 'never',
              registeredAt: row?.created_at,
              expiresAt,
              ttlSeconds: metadata.ttlSeconds,
              lifecycleStatus: metadata.lifecycleStatus || metadata.status,
              capabilities: row ? parseRegistrationJson(row.capabilities_json, []) : [],
              aliases: this.memoryManager.getAgentAliases(targetAgentId, tenantId)
            };
          } else {
            // All rows feed the canonical rollup (deduped, naturally bounded by
            // distinct logical agents). The RAW agents list is the unbounded part
            // — with 2,000+ ephemeral bridge registrations it was a ~1MB dump —
            // so it is limit/offset paginated. Counts are reported so any
            // truncation is explicit, never silent.
            const totalRow = db.prepare(
              `SELECT COUNT(*) c FROM agent_registrations WHERE tenant_id = ?`
            ).get(tenantId) as { c: number };
            const totalRegistrations = totalRow?.c ?? 0;

            const rows = db.prepare(
              `SELECT agent_id, name, capabilities_json, metadata_json, status, created_at, updated_at
               FROM agent_registrations
               WHERE tenant_id = ?
               ORDER BY updated_at DESC`
            ).all(tenantId) as any[];

            const pagedRows = rows.slice(statusOffset, statusOffset + statusLimit);
            const agents = pagedRows.map(row => {
              const metadata = parseRegistrationJson(row.metadata_json, {});
              const expiresAt = registrationExpiresAt(metadata);
              return {
                agentId: row.agent_id,
                canonicalAgentId: this.memoryManager.inferCanonicalAgentId(row.agent_id, row.name, metadata),
                name: row.name,
                status: effectiveRegistrationStatus(row.status, metadata),
                storedStatus: row.status,
                lastSeen: row.updated_at,
                registeredAt: row.created_at,
                expiresAt,
                ttlSeconds: metadata.ttlSeconds,
              };
            });
            const nextOffset = statusOffset + statusLimit < rows.length ? statusOffset + statusLimit : null;

            const canonicalMap = new Map<string, any>();
            if (groupByCanonical) {
              for (const row of rows) {
                const metadata = parseRegistrationJson(row.metadata_json, {});
                const canonicalAgentId = this.memoryManager.inferCanonicalAgentId(row.agent_id, row.name, metadata);
                const rowStatus = effectiveRegistrationStatus(row.status, metadata);
                const existing = canonicalMap.get(canonicalAgentId) || {
                  agentId: canonicalAgentId,
                  name: row.name,
                  status: 'inactive',
                  lastSeen: row.updated_at,
                  expiresAt: registrationExpiresAt(metadata),
                  aliases: [],
                  sessionCount: 0,
                  capabilities: [],
                };
                existing.sessionCount += 1;
                if (rowStatus === 'active') {
                  existing.status = 'active';
                } else if (existing.status !== 'active') {
                  existing.status = rowStatus;
                }
                if (String(row.updated_at || '') > String(existing.lastSeen || '')) {
                  existing.lastSeen = row.updated_at;
                  existing.name = row.name;
                  existing.expiresAt = registrationExpiresAt(metadata) || existing.expiresAt;
                }
                existing.aliases = Array.from(new Set([
                  ...existing.aliases,
                  row.agent_id,
                  ...(Array.isArray(metadata.aliases) ? metadata.aliases : []),
                ].filter(Boolean)));
                existing.capabilities = Array.from(new Set([
                  ...existing.capabilities,
                  ...parseRegistrationJson(row.capabilities_json, []),
                ]));
                canonicalMap.set(canonicalAgentId, existing);
              }
            }

            // The canonical rollup can itself be large when ephemeral bridge IDs
            // each infer to a distinct canonical agent. Cap it (most-recent first)
            // and report the true total so the response stays bounded.
            const allCanonical = groupByCanonical
              ? Array.from(canonicalMap.values()).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
              : [];
            const canonicalReturned = allCanonical.slice(0, statusLimit);

            statusData = {
              totalRegistrations,
              totalCanonicalAgents: canonicalMap.size || undefined,
              returnedRegistrations: agents.length,
              returnedCanonicalAgents: groupByCanonical ? canonicalReturned.length : undefined,
              offset: statusOffset,
              nextOffset,
              agents,
              canonicalAgents: groupByCanonical ? canonicalReturned : undefined
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(statusData, null, 2),
              },
            ],
          };
        }

        // === CROSS-PLATFORM SUPPORT ===
        case 'translate_path': {
          const { path, fromPlatform, toPlatform } = args;
          
          const translatedPath = this.translatePath(path, fromPlatform, toPlatform);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  originalPath: path,
                  fromPlatform,
                  toPlatform,
                  translatedPath,
                  pathInfo: {
                    isAbsolute: path.startsWith('/') || path.match(/^[A-Z]:/),
                    containsSpaces: path.includes(' '),
                    pathSeparator: toPlatform === 'windows' ? '\\' : '/',
                    isValid: true
                  }
                }, null, 2),
              },
            ],
          };
        }

        // === KNOWLEDGE GRAPH MUTATIONS (Phase A) ===
        case 'delete_entity': {
          const { entityName, dryRun = false, reason } = args;
          const actor = context.userId || context.apiKeyId || agent;

          // Authorization (codex finding #1: context only, never args)
          const authResult = this.memoryManager.authorizeGraphMutation('delete_entity', context);
          if (!authResult.authorized) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: authResult.reason }) }],
              isError: true,
            };
          }

          if (this.memoryManager.isConfidentialEntityReference(entityName, tenantId)) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          // Find targets (tenant-scoped)
          const entityRows = this.memoryManager.findEntitiesByName(entityName, tenantId);
          if (entityRows.length === 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Not Found', message: `Entity "${entityName}" not found in tenant ${tenantId}` }) }],
              isError: true,
            };
          }
          if (entityRows.some((row: any) =>
            this.memoryManager.isConfidentialGraphRow('entity', row.content, tenantId)
          )) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          const observationRows = this.memoryManager.findObservationsByEntity(entityName, tenantId);
          const relationRows = this.memoryManager.findRelationsByEntity(entityName, tenantId);

          // Phase B: member_provenance → enforce row-level ownership on all target rows
          if (authResult.reason === 'member_provenance') {
            const allRows = [...entityRows, ...observationRows, ...relationRows];
            const ownerCheck = this.memoryManager.checkMemberOwnership(allRows, context);
            if (!ownerCheck.allowed) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: ownerCheck.reason }) }],
                isError: true,
              };
            }
          }

          const allTargetIds = [
            ...entityRows.map((r: any) => r.id),
            ...observationRows.map((r: any) => r.id),
            ...relationRows.map((r: any) => r.id),
          ];

          if (dryRun) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  dryRun: true,
                  entityName,
                  actor,
                  targets: {
                    entities: entityRows.length,
                    observations: observationRows.length,
                    relations: relationRows.length,
                    totalRows: allTargetIds.length,
                  },
                  entityIds: entityRows.map((r: any) => r.id),
                  observationIds: observationRows.map((r: any) => r.id),
                  relationIds: relationRows.map((r: any) => r.id),
                }, null, 2),
              }],
            };
          }

          // Execute cascade delete
          const deleteResult = await this.memoryManager.deleteGraphRows(allTargetIds, tenantId);

          // Audit (codex finding #6)
          this.memoryManager.auditMutationOp('delete_entity', context, entityName, allTargetIds, reason);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'deleted',
                entityName,
                actor,
                reason: reason || null,
                deleted: {
                  entities: entityRows.length,
                  observations: observationRows.length,
                  relations: relationRows.length,
                  totalRows: deleteResult.deleted,
                },
                vectorCleanup: deleteResult.vectorCleanup,
                vectorFailures: deleteResult.vectorFailures,
              }, null, 2),
            }],
          };
        }

        case 'remove_observations': {
          const { entityName, observationIds, containsAny, dryRun = false, reason } = args;
          const actor = context.userId || context.apiKeyId || agent;

          // Authorization
          const authResult = this.memoryManager.authorizeGraphMutation('remove_observations', context);
          if (!authResult.authorized) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: authResult.reason }) }],
              isError: true,
            };
          }

          if (this.memoryManager.isConfidentialEntityReference(entityName, tenantId)) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          // Find targets based on selector
          let targetRows: any[] = [];
          if (observationIds && observationIds.length > 0) {
            // Mutation selection uses raw rows. Read helpers omit private
            // children, which would turn an explicit mixed/private target into
            // a misleading partial success instead of a fail-closed rejection.
            const allObs = this.memoryManager.findObservationRowsForMutation(entityName, tenantId);
            const idSet = new Set(observationIds);
            targetRows = allObs.filter((r: any) => idSet.has(r.id));
          } else if (containsAny && containsAny.length > 0) {
            targetRows = this.memoryManager.findObservationsByContainsAny(entityName, containsAny, tenantId);
          } else {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Bad Request', message: 'Provide observationIds or containsAny selector' }) }],
              isError: true,
            };
          }

          if (targetRows.some((row: any) =>
            this.memoryManager.isConfidentialGraphRow('observation', row.content, tenantId)
          )) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          if (targetRows.length === 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ status: 'no_match', entityName, matchedObservations: 0 }) }],
            };
          }

          // Phase B: member_provenance → enforce row-level ownership
          if (authResult.reason === 'member_provenance') {
            const ownerCheck = this.memoryManager.checkMemberOwnership(targetRows, context);
            if (!ownerCheck.allowed) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: ownerCheck.reason }) }],
                isError: true,
              };
            }
          }

          const targetIds = targetRows.map((r: any) => r.id);

          if (dryRun) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  dryRun: true,
                  entityName,
                  actor,
                  matchedObservations: targetIds.length,
                  observationIds: targetIds,
                }, null, 2),
              }],
            };
          }

          const deleteResult = await this.memoryManager.deleteGraphRows(targetIds, tenantId);
          this.memoryManager.auditMutationOp('remove_observations', context, entityName, targetIds, reason);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'removed',
                entityName,
                actor,
                reason: reason || null,
                removedObservations: deleteResult.deleted,
                vectorCleanup: deleteResult.vectorCleanup,
                vectorFailures: deleteResult.vectorFailures,
              }, null, 2),
            }],
          };
        }

        case 'update_observation': {
          const { observationId, contentIndex, newContent, reason } = args;
          const actor = context.userId || context.apiKeyId || agent;

          // Authorization
          const authResult = this.memoryManager.authorizeGraphMutation('update_observation', context);
          if (!authResult.authorized) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: authResult.reason }) }],
              isError: true,
            };
          }

          const obsRow = this.memoryManager.getObservationRow(observationId, tenantId);
          if (obsRow && this.memoryManager.isConfidentialGraphRow('observation', obsRow.content, tenantId)) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          // Sanitizer parity (codex finding #3)
          const sanitizeResult = MemoryManager.sanitizeContent(newContent);
          if (!sanitizeResult.safe) {
            this.memoryManager.auditLog('update_observation', actor, newContent, observationId, true, sanitizeResult.reason);
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Content Rejected', message: `Content flagged by sanitizer: ${sanitizeResult.reason}` }) }],
              isError: true,
            };
          }

          // Phase B: member_provenance → fetch row and check ownership before updating
          if (authResult.reason === 'member_provenance') {
            if (obsRow) {
              const ownerCheck = this.memoryManager.checkMemberOwnership([obsRow], context);
              if (!ownerCheck.allowed) {
                return {
                  content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: ownerCheck.reason }) }],
                  isError: true,
                };
              }
            }
          }

          const updateResult = await this.memoryManager.updateObservationContent(
            observationId, newContent, contentIndex, tenantId
          );

          this.memoryManager.auditMutationOp('update_observation', context, observationId, [observationId], reason);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'updated',
                observationId,
                actor,
                reason: reason || null,
                updated: updateResult.updated,
                vectorReindexed: updateResult.vectorReindexed,
              }, null, 2),
            }],
          };
        }

        case 'delete_observations_by_entity': {
          const { entityName, dryRun = false, reason } = args;
          const actor = context.userId || context.apiKeyId || agent;

          // Authorization
          const authResult = this.memoryManager.authorizeGraphMutation('delete_observations_by_entity', context);
          if (!authResult.authorized) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: authResult.reason }) }],
              isError: true,
            };
          }

          if (this.memoryManager.isConfidentialEntityReference(entityName, tenantId)) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          const observationRows = this.memoryManager.findObservationRowsForMutation(entityName, tenantId);

          if (observationRows.some((row: any) =>
            this.memoryManager.isConfidentialGraphRow('observation', row.content, tenantId)
          )) {
            throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
          }

          if (observationRows.length === 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ status: 'no_match', entityName, matchedObservations: 0 }) }],
            };
          }

          // Phase B: member_provenance → enforce row-level ownership
          if (authResult.reason === 'member_provenance') {
            const ownerCheck = this.memoryManager.checkMemberOwnership(observationRows, context);
            if (!ownerCheck.allowed) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', message: ownerCheck.reason }) }],
                isError: true,
              };
            }
          }

          const targetIds = observationRows.map((r: any) => r.id);

          if (dryRun) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  dryRun: true,
                  entityName,
                  actor,
                  matchedObservations: targetIds.length,
                  observationIds: targetIds,
                }, null, 2),
              }],
            };
          }

          const deleteResult = await this.memoryManager.deleteGraphRows(targetIds, tenantId);
          this.memoryManager.auditMutationOp('delete_observations_by_entity', context, entityName, targetIds, reason);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'deleted',
                entityName,
                actor,
                reason: reason || null,
                deletedObservations: deleteResult.deleted,
                vectorCleanup: deleteResult.vectorCleanup,
                vectorFailures: deleteResult.vectorFailures,
              }, null, 2),
            }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof AgentAuthorizationError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Agent authorization failed',
              code: error.code,
            }),
          }],
          structuredContent: {
            error: 'Agent authorization failed',
            code: error.code,
          },
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text', text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` },
        ],
        isError: true,
      };
    }
  }

  // === HELPER METHODS ===
  private serializeWithTokenEstimate<T extends Record<string, any>>(payload: T, pretty: boolean = true): string {
    const response: any = {
      ...payload,
      meta: {
        ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
        responseCharacters: 0,
        tokenEstimate: 0,
        tokenEstimator: 'json_chars_div_4',
      },
    };

    let serialized = '';
    for (let pass = 0; pass < 8; pass++) {
      serialized = JSON.stringify(response, null, pretty ? 2 : undefined);
      const responseCharacters = serialized.length;
      const tokenEstimate = Math.ceil(responseCharacters / 4);
      if (response.meta.responseCharacters === responseCharacters &&
          response.meta.tokenEstimate === tokenEstimate) {
        return serialized;
      }
      response.meta.responseCharacters = responseCharacters;
      response.meta.tokenEstimate = tokenEstimate;
    }

    return JSON.stringify(response, null, pretty ? 2 : undefined);
  }

  private messageDeliveryStatus(msg: any, metadata: any = {}): 'queued' | 'delivered' | 'read' | 'failed' {
    if (msg?.read_at) return 'read';
    if (msg?.delivered_at) return 'delivered';
    if (metadata?.deliveryStatus === 'failed') return 'failed';
    return 'queued';
  }

  private async simulateRealTimeDelivery(
    messageData: any,
    messageId?: string
  ): Promise<{ deliveryStatus: 'queued' | 'delivered'; clientsNotified: number }> {
    console.log(`⚡ Real-time delivery: ${messageData.from} → ${messageData.to}`);

    try {
      if (this.messageHub) {
        const clientsNotified = await this.messageHub.notifyAgentOfMessage(messageData.to, {
          messageId: messageId || messageData.id,
          from: messageData.from,
          content: messageData.content,
          priority: messageData.priority,
          tenantId: messageData.tenantId,
          timestamp: messageData.timestamp
        });
        if (clientsNotified > 0) {
          messageData.deliveryStatus = 'delivered';
          if (messageId) {
            await this.memoryManager.updateMessageStatus(messageId, messageData.deliveryStatus);
          }
          return { deliveryStatus: 'delivered', clientsNotified };
        }
      }
    } catch (error) {
      console.error(`❌ Push notification failed for ${messageData.to}; message remains queued:`, error);
    }
    return { deliveryStatus: 'queued', clientsNotified: 0 };
  }

  private async simulateAgentRegistration(agentData: any) {
    // Simulate unified server registration
    console.log(`🤖 Agent registered: ${agentData.agentId} (${agentData.name})`);
  }

  // === UTILITY METHODS ===
  private translatePath(path: string, fromPlatform: string, toPlatform: string): string {
    if (fromPlatform === toPlatform) return path;
    
    // Simple path translation simulation
    if (fromPlatform === 'windows' && toPlatform === 'wsl') {
      return path.replace(/^([A-Z]):/, '/mnt/$1').toLowerCase().replace(/\\/g, '/');
    } else if (fromPlatform === 'wsl' && toPlatform === 'windows') {
      return path.replace(/^\/mnt\/([a-z])/, '$1:').replace(/\//g, '\\');
    }
    
    return path;
  }

  start(): Promise<void> {
    if (this.lifecycleState === 'closing' || this.lifecycleState === 'closed') {
      return Promise.reject(new Error('Cannot start a HYTHE server that is closing or closed'));
    }
    if (this.lifecycleState === 'ready') return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.lifecycleState = 'starting';
    this.startPromise = this.startServer();
    return this.startPromise;
  }

  private async startServer(): Promise<void> {
    try {
      if (this.messageHub) {
        await this.messageHub.start();
        this.messageHubStarted = true;
      }

      if (this.isShuttingDown()) {
        await this.shutdownResources();
        return;
      }

      // Start SLO monitoring (check every 60 seconds).
      startSLOMonitoring(60000);

      // Event compaction with 30-day retention (per PM guidance).
      metrics.startCompaction();

      await new Promise<void>((resolve, reject) => {
        const listener = this.app.listen(this.port);
        this.httpServer = listener;

        const onError = (error: Error) => {
          listener.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          listener.off('error', onError);
          const address = listener.address();
          if (address && typeof address !== 'string') {
            this.port = (address as AddressInfo).port;
          }
          resolve();
        };

        listener.once('error', onError);
        listener.once('listening', onListening);
      });

      if (this.isShuttingDown()) {
        await this.shutdownResources();
        return;
      }
      this.lifecycleState = 'ready';

      console.log(`🧠 Unified Neural AI Collaboration MCP Server started on port ${this.port}`);
      console.log(`📡 MCP Endpoint: http://localhost:${this.port}/mcp`);
      console.log(`💬 AI Messaging: http://localhost:${this.port}/ai-message`);
      console.log(`📊 Health Check: http://localhost:${this.port}/health`);
      console.log(`✅ Readiness Check: http://localhost:${this.port}/ready`);
      console.log(`📈 SLO Status: http://localhost:${this.port}/slo/status`);
      console.log(`🔧 System Status: http://localhost:${this.port}/system/status`);

      if (this.messageHub) {
        const hubPort = this.messageHub.getPort();
        console.log(`📡 Message Hub WebSocket: ws://localhost:${hubPort}`);
        console.log('⚡ Real-time notifications: <100ms message discovery');
      }

      console.log('🌟 Capabilities:');
      console.log('   🧠 Knowledge Graph (SQLite + Weaviate)');
      console.log('   💬 AI Agent Messaging');
      console.log('   🌐 Cross-Platform Path Translation');
      console.log('   📈 Observability & SLOs');
      console.log('');
      console.log('🚀 Ready for Neural AI Collaboration!');
    } catch (error) {
      this.lifecycleState = 'closing';
      try {
        await this.shutdownResources();
      } catch (shutdownError) {
        console.error('Failed to clean up after HYTHE startup error:', shutdownError);
      }
      throw error;
    }
  }

  /**
   * Stop accepting traffic, drain listeners and background work, then close
   * SQLite. The returned promise is stable, so repeated shutdown requests all
   * observe the same result and never close a resource twice.
   */
  close(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.lifecycleState === 'closed') return Promise.resolve();

    const wasStarting = this.lifecycleState === 'starting';
    this.lifecycleState = 'closing';
    this.shutdownPromise = wasStarting && this.startPromise
      ? this.startPromise.catch(() => undefined).then(() => this.shutdownResources())
      : this.shutdownResources();
    return this.shutdownPromise;
  }

  private isShuttingDown(): boolean {
    return this.lifecycleState === 'closing' || this.lifecycleState === 'closed';
  }

  private stopHttpListener(): Promise<void> {
    const listener = this.httpServer;
    this.httpServer = undefined;
    if (!listener?.listening) return Promise.resolve();

    // Calling close immediately stops new connections. Its callback fires only
    // after requests already accepted by Node's HTTP server have drained.
    return new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
  }

  private shutdownResources(): Promise<void> {
    if (this.resourceShutdownPromise) return this.resourceShutdownPromise;

    const hasAsyncListeners = Boolean(this.httpServer?.listening || this.messageHubStarted);
    if (!hasAsyncListeners) {
      // Most in-process tests construct the app without calling start(). Keep
      // their historical fire-and-forget close safe while still returning an
      // awaitable, idempotent promise.
      stopSLOMonitoring();
      void metrics.stopCompaction();
      const memoryClose = this.memoryManager.close();
      this.resourceShutdownPromise = memoryClose.then(() => {
        this.lifecycleState = 'closed';
      });
      return this.resourceShutdownPromise;
    }

    const httpDrain = this.stopHttpListener();
    this.resourceShutdownPromise = (async () => {
      const errors: unknown[] = [];

      if (this.messageHub && this.messageHubStarted) {
        try {
          await this.messageHub.stop();
        } catch (error) {
          errors.push(error);
        } finally {
          this.messageHubStarted = false;
        }
      }

      stopSLOMonitoring();
      try {
        await metrics.stopCompaction();
      } catch (error) {
        errors.push(error);
      }

      try {
        await httpDrain;
      } catch (error) {
        errors.push(error);
      }

      // SQLite must be the last resource closed: requests and background work
      // above may still need it while they drain.
      try {
        await this.memoryManager.close();
      } catch (error) {
        errors.push(error);
      }

      this.lifecycleState = 'closed';
      if (errors.length > 0) {
        throw new AggregateError(errors, 'HYTHE shutdown encountered one or more errors');
      }
    })();

    return this.resourceShutdownPromise;
  }

  /** Expose Express app for testing (supertest). */
  getExpressApp(): express.Application {
    return this.app;
  }

  /** Expose MemoryManager for direct testing. */
  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }
}

// Start server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Fail fast on a missing/malformed auth config. Prevents booting a server
  // that looks healthy (/health is public) but rejects every authenticated
  // request with AUTH_NOT_CONFIGURED and silently drops all MCP clients.
  const authCheck = checkAuthConfigured();
  if (!authCheck.ok) {
    console.error(`❌ FATAL: ${authCheck.reason}`);
    process.exit(1);
  }

  const port = parseInt(process.env.NEURAL_MCP_PORT || '6174');
  // Optional DB path override (defaults to ./data/unified-platform.db). Lets an
  // isolated/test server run against a throwaway DB without touching prod data.
  const dbPath = process.env.NEURAL_DB_PATH || undefined;
  const server = new NeuralMCPServer(port, dbPath);

  let shutdownStarted = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`🛑 ${signal} received; draining HYTHE`);
    void server.close().then(() => {
      console.log('✅ HYTHE shutdown complete');
      process.exitCode = 0;
    }).catch((error) => {
      console.error('❌ HYTHE shutdown failed:', error);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  server.start().catch((error) => {
    console.error('Failed to start Unified Neural MCP Server:', error);
    process.exitCode = 1;
  });
}
