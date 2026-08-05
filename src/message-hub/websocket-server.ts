import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createServer, type IncomingMessage } from 'http';
import { isValidApiKeyFormat, safeKeyEqual } from '../middleware/security.js';
import { getTenantManager } from '../tenant/index.js';

// WebSocket event types for real-time notifications
export interface MessageHubEvent {
  type: 'message.new' | 'message.read' | 'agent.online' | 'agent.offline' | 'heartbeat';
  agentId?: string;
  targetAgentId?: string;
  tenantId?: string;
  messageId?: string;
  content?: any;
  timestamp: string;
}

export interface MessageHubPrincipal {
  agentId: string;
  tenantId: string;
}

interface AuthenticatedHubRequest extends IncomingMessage {
  messageHubPrincipal?: MessageHubPrincipal;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Authenticate a WebSocket upgrade with the same API-key aliases and
 * constant-time comparison used by the HTTP surface. The agent identity is
 * supplied during the authenticated handshake and cannot be changed later by
 * register/subscribe messages.
 */
function authenticateMessageHubRequest(request: IncomingMessage): MessageHubPrincipal | null {
  let query: URLSearchParams | undefined;
  try {
    query = new URL(request.url || '/', 'http://localhost').searchParams;
  } catch {
    return null;
  }

  const agentId = (headerValue(request, 'x-neural-agent-id') || query.get('agent_id') || '').trim();
  if (!agentId || agentId.length > 256 || /[\x00-\x1F\x7F]/.test(agentId)) return null;

  const authorization = headerValue(request, 'authorization') || '';
  const bearerKey = authorization.replace(/^Bearer\s+/i, '');
  const providedKey = headerValue(request, 'x-api-key') || bearerKey || query.get('api_key') || '';
  if (!isValidApiKeyFormat(providedKey)) return null;

  // Match HTTP auth ordering: tenant keys first, then the legacy env key.
  if (process.env.MULTI_TENANT_ENABLED === 'true') {
    try {
      const validation = getTenantManager().validateApiKey(providedKey);
      if (validation.valid && validation.tenant && validation.record) {
        return {
          agentId,
          tenantId: validation.tenant.id,
        };
      }
    } catch {
      // Fall through to the legacy env-key path, as HTTP auth does.
    }
  }

  const configuredKey = process.env.API_KEY || process.env.NEURAL_API_KEY;
  if (!configuredKey || !safeKeyEqual(providedKey, configuredKey)) return null;
  return { agentId, tenantId: 'default' };
}

// Connected client information
interface ConnectedClient {
  ws: WebSocket;
  agentId: string;
  tenantId: string;
  lastHeartbeat: Date;
  subscriptions: Set<string>; // Agent IDs this client wants notifications for
}

/**
 * WebSocket Notification Server for Centralized Message Hub
 * Port: 3002
 * Purpose: Real-time notifications for <1 second message discovery
 */
export class MessageHubWebSocketServer extends EventEmitter {
  private wss: WebSocketServer;
  private server: any;
  private clients: Map<string, ConnectedClient> = new Map();
  private port: number;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(port: number = 3003) {
    super();
    this.port = port;
    this.server = createServer();
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: ({ req }: { origin: string; secure: boolean; req: IncomingMessage }) => {
        try {
          const principal = authenticateMessageHubRequest(req);
          if (!principal) return false;
          (req as AuthenticatedHubRequest).messageHubPrincipal = principal;
          return true;
        } catch {
          return false;
        }
      },
    });
    this.setupWebSocketServer();
  }

  private setupWebSocketServer() {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const principal = (req as AuthenticatedHubRequest).messageHubPrincipal;
      if (!principal) {
        ws.close(1008, 'Authentication required');
        return;
      }
      console.log('🔌 New WebSocket connection from:', req.socket.remoteAddress);
      
      // Connection ID for tracking
      const connectionId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Handle initial connection
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(connectionId, ws, principal, message);
        } catch (error) {
          console.error('❌ Invalid JSON from WebSocket client:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid JSON format',
            timestamp: new Date().toISOString()
          }));
        }
      });

      ws.on('close', () => {
        console.log('🔌 WebSocket client disconnected:', connectionId);
        this.handleClientDisconnect(connectionId);
      });

      ws.on('error', (error) => {
        console.error('❌ WebSocket error for client:', connectionId, error);
        this.handleClientDisconnect(connectionId);
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connection.welcome',
        connectionId,
        message: 'Connected to Message Hub WebSocket',
        authenticatedAgentId: principal.agentId,
        timestamp: new Date().toISOString()
      }));
    });

    console.log(`📡 WebSocket server configured on port ${this.port}`);
  }

  private handleClientMessage(
    connectionId: string,
    ws: WebSocket,
    principal: MessageHubPrincipal,
    message: any
  ) {
    switch (message.type) {
      case 'register':
        this.handleClientRegistration(connectionId, ws, principal, message);
        break;
      
      case 'subscribe':
        this.handleSubscription(connectionId, message);
        break;
      
      case 'unsubscribe':
        this.handleUnsubscription(connectionId, message);
        break;
      
      case 'heartbeat':
        this.handleHeartbeat(connectionId);
        break;
      
      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: `Unknown message type: ${message.type}`,
          timestamp: new Date().toISOString()
        }));
    }
  }

  private handleClientRegistration(
    connectionId: string,
    ws: WebSocket,
    principal: MessageHubPrincipal,
    message: any
  ) {
    if (!message.agentId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'agentId required for registration',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    if (message.agentId !== principal.agentId) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'AGENT_IDENTITY_MISMATCH',
        message: 'Registered agentId must match the authenticated WebSocket identity',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    const client: ConnectedClient = {
      ws,
      agentId: principal.agentId,
      tenantId: principal.tenantId,
      lastHeartbeat: new Date(),
      subscriptions: new Set()
    };

    // Auto-subscribe to own messages
    client.subscriptions.add(message.agentId);

    this.clients.set(connectionId, client);

    // Notify that agent is online
    this.broadcastEvent({
      type: 'agent.online',
      agentId: principal.agentId,
      tenantId: principal.tenantId,
      timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({
      type: 'registration.success',
      agentId: principal.agentId,
      connectionId,
      subscriptions: Array.from(client.subscriptions),
      timestamp: new Date().toISOString()
    }));

    console.log(`✅ Agent registered: ${principal.agentId} (${connectionId})`);
  }

  private handleSubscription(connectionId: string, message: any) {
    const client = this.clients.get(connectionId);
    if (!client) {
      return; // Client not registered
    }

    if (message.targetAgentId && message.targetAgentId !== client.agentId) {
      client.ws.send(JSON.stringify({
        type: 'subscription.denied',
        targetAgentId: message.targetAgentId,
        message: 'WebSocket clients may subscribe only to their authenticated agent identity',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    if (message.targetAgentId === client.agentId) {
      client.subscriptions.add(client.agentId);
      client.ws.send(JSON.stringify({
        type: 'subscription.success',
        targetAgentId: client.agentId,
        timestamp: new Date().toISOString()
      }));
    }
  }

  private handleUnsubscription(connectionId: string, message: any) {
    const client = this.clients.get(connectionId);
    if (!client) {
      return; // Client not registered
    }

    if (message.targetAgentId) {
      client.subscriptions.delete(message.targetAgentId);
      client.ws.send(JSON.stringify({
        type: 'unsubscription.success',
        targetAgentId: message.targetAgentId,
        timestamp: new Date().toISOString()
      }));
    }
  }

  private handleHeartbeat(connectionId: string) {
    const client = this.clients.get(connectionId);
    if (client) {
      client.lastHeartbeat = new Date();
      client.ws.send(JSON.stringify({
        type: 'heartbeat.ack',
        timestamp: new Date().toISOString()
      }));
    }
  }

  private handleClientDisconnect(connectionId: string) {
    const client = this.clients.get(connectionId);
    if (client) {
      // Notify that agent is offline
      this.broadcastEvent({
        type: 'agent.offline',
        agentId: client.agentId,
        tenantId: client.tenantId,
        timestamp: new Date().toISOString()
      });

      this.clients.delete(connectionId);
      console.log(`🔌 Agent disconnected: ${client.agentId} (${connectionId})`);
    }
  }

  /**
   * Broadcast event to all subscribed clients
   * This is the core notification mechanism for <1 second message discovery
   */
  public broadcastEvent(event: MessageHubEvent): number {
    const eventStr = JSON.stringify(event);
    let notifiedClients = 0;

    this.clients.forEach((client, connectionId) => {
      // Check if client is interested in this event
      const shouldNotify = this.shouldNotifyClient(client, event);
      
      if (shouldNotify && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(eventStr);
          notifiedClients++;
        } catch (error) {
          console.error(`❌ Failed to send to client ${connectionId}:`, error);
          this.handleClientDisconnect(connectionId);
        }
      }
    });

    console.log(`📡 Event broadcast: ${event.type} → ${notifiedClients} clients`);
    
    // Emit to internal event system for logging/metrics
    this.emit('event.broadcast', event, notifiedClients);
    return notifiedClients;
  }

  private shouldNotifyClient(client: ConnectedClient, event: MessageHubEvent): boolean {
    switch (event.type) {
      case 'message.new':
        // A delivery fact requires an authenticated, exact-recipient connection.
        return Boolean(event.targetAgentId === client.agentId &&
          client.subscriptions.has(client.agentId) &&
          (!event.tenantId || event.tenantId === client.tenantId));
      
      case 'message.read':
        // Notify if client subscribed to sender or receiver
        return Boolean((!event.tenantId || event.tenantId === client.tenantId) &&
          ((event.agentId && client.subscriptions.has(event.agentId)) ||
           (event.targetAgentId && client.subscriptions.has(event.targetAgentId))));
      
      case 'agent.online':
      case 'agent.offline':
        // Notify all clients about agent status changes
        return !event.tenantId || event.tenantId === client.tenantId;
      
      case 'heartbeat':
        // Only notify the specific agent
        return event.agentId === client.agentId;
      
      default:
        return false;
    }
  }

  /**
   * Public method for Message Hub API to notify new messages
   * This enables <1 second message discovery
   */
  public notifyNewMessage(
    messageId: string,
    from: string,
    to: string,
    content?: string,
    tenantId: string = 'default'
  ): number {
    return this.broadcastEvent({
      type: 'message.new',
      messageId,
      agentId: from,
      targetAgentId: to,
      tenantId,
      content: content ? { preview: content.substring(0, 100) } : undefined,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Public method to notify message read status
   */
  public notifyMessageRead(messageId: string, from: string, to: string) {
    this.broadcastEvent({
      type: 'message.read',
      messageId,
      agentId: from,
      targetAgentId: to,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Start the WebSocket server
   */
  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`📡 Message Hub WebSocket Server started on port ${this.port}`);
        console.log(`🔄 Real-time notifications enabled for <1s message discovery`);
        
        // Start heartbeat monitoring
        this.startHeartbeatMonitoring();
        
        resolve();
      });
    });
  }

  /**
   * Monitor client heartbeats and cleanup dead connections
   */
  private startHeartbeatMonitoring() {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      const timeoutMs = 60000; // 1 minute timeout

      this.clients.forEach((client, connectionId) => {
        const timeSinceHeartbeat = now.getTime() - client.lastHeartbeat.getTime();
        if (timeSinceHeartbeat > timeoutMs) {
          console.log(`⏰ Client timeout: ${client.agentId} (${connectionId})`);
          this.handleClientDisconnect(connectionId);
        }
      });
    }, 30000); // Check every 30 seconds
  }

  /**
   * Stop the WebSocket server
   */
  public async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all client connections
    this.clients.forEach((client) => {
      client.ws.close();
    });
    this.clients.clear();

    // Close the server
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('📡 Message Hub WebSocket Server stopped');
        resolve();
      });
    });
  }

  /**
   * Get connection statistics
   */
  public getStats() {
    const stats = {
      connectedClients: this.clients.size,
      totalSubscriptions: 0,
      clientDetails: [] as any[]
    };

    this.clients.forEach((client, connectionId) => {
      stats.totalSubscriptions += client.subscriptions.size;
      stats.clientDetails.push({
        connectionId,
        agentId: client.agentId,
        tenantId: client.tenantId,
        subscriptions: Array.from(client.subscriptions),
        lastHeartbeat: client.lastHeartbeat
      });
    });

    return stats;
  }
}
