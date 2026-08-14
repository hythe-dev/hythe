#!/usr/bin/env node

const http = require('http');
const readline = require('readline');
const os = require('os');
const fs = require('fs');
const path = require('path');

// P1 compatibility seam. The legacy package keeps its historical MCP
// serverInfo name; the publish-blocked HYTHE overlay opts into the new display
// identity without changing tools, endpoints, auth, or graph keys.
const PACKAGE_META = require('./package.json');
const SERVER_INFO_NAME = PACKAGE_META.hytheDistribution === true
  ? 'hythe'
  : 'neural-ai-collaboration';
const HYTHE_DISTRIBUTION = PACKAGE_META.hytheDistribution === true;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ENGRAM_URI_SEGMENT_PATTERN = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/;
// Tools whose `agentId` is the acting/owning identity, rather than a lookup or
// delivery target. The bridge binds these calls to its immutable lane identity
// before they can reach the shared HTTP server. Keep explicit target fields
// (`send_ai_message.agentId`, `get_agent_status.agentId`, filters) out of this
// set: they are not claims about the caller.
const AGENT_ID_BOUND_TOOLS = new Set([
  'create_entities',
  'add_observations',
  'create_relations',
  'compact_memory',
  'delete_entity',
  'remove_observations',
  'update_observation',
  'delete_observations_by_entity',
  'record_learning',
  'set_preferences',
  'get_individual_memory',
  'get_agent_context',
  'begin_session',
  'end_session',
  'checkpoint',
  'resume',
  'get_ai_messages',
  'get_message_detail',
  'mark_messages_read',
  'archive_messages',
  'register_agent',
  'unregister_agent',
]);

// MCP target. Defaults to localhost:6174, overridable via env.
const SERVER_HOSTNAME = process.env.MCP_HOST || 'localhost';
const SERVER_PORT = parseInt(process.env.MCP_PORT || '6174', 10);
const shortHost = os.hostname().split('.')?.[0] || 'host';

function normalizeAgentId(value, source) {
  if (typeof value !== 'string') {
    throw new Error(`${source} must be a string`);
  }
  if (
    value.length < 1
    || value.length > 100
    || !AGENT_ID_PATTERN.test(value)
  ) {
    throw new Error(`${source} must be 1-100 characters from A-Z, a-z, 0-9, _, ., :, or -`);
  }
  return value;
}

function configuredAgentIdentity() {
  const logicalCandidates = ['HYTHE_AGENT_ID', 'ENGRAM_AGENT_ID']
    .filter((source) => Object.prototype.hasOwnProperty.call(process.env, source))
    .map((source) => ({ source, value: normalizeAgentId(process.env[source], source) }));
  const transportCandidates = ['FROM', 'MCP_FROM']
    .filter((source) => Object.prototype.hasOwnProperty.call(process.env, source))
    .map((source) => ({ source, value: normalizeAgentId(process.env[source], source) }));
  const candidates = [...logicalCandidates, ...transportCandidates];

  const distinctValues = new Set(candidates.map(({ value }) => value));
  if (distinctValues.size > 1) {
    throw new Error(
      `${candidates.map(({ source }) => source).join(' and ')} conflict: `
      + 'configured agent identities disagree'
    );
  }
  // The HYTHE distribution never lets transport compatibility variables
  // select logical identity. They may only confirm an explicit logical value.
  if (HYTHE_DISTRIBUTION) return logicalCandidates[0] || null;
  return logicalCandidates[0] || transportCandidates[0] || null;
}

// Stable per-host identity. Previously this minted a NEW id per process
// (`agent-<host>-<pid>-<ts>`) and auto-registered it, so every CLI launch left
// a throwaway agent row forever (~1,949 of 2,003 registrations on the live DB).
// Instead, persist one stable id per host to a cache file and reuse it across
// processes, so reconnects keep the same identity and the registry stops
// growing. This fallback is legacy-only: the HYTHE distribution requires an
// explicit client-lane identity so a compaction/restart cannot silently adopt
// the host-wide generated identity.
function loadOrCreateStableFrom() {
  const dir = process.env.MCP_BRIDGE_STATE_DIR
    || path.join(os.homedir() || os.tmpdir(), '.neural-mcp');
  const file = path.join(dir, `bridge-identity-${shortHost}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.agentId === 'string' && saved.agentId.length > 0) {
      return normalizeAgentId(saved.agentId, 'persisted bridge identity');
    }
  } catch (_) { /* no cache yet */ }
  const id = `agent-${shortHost}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agentId: id, createdAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    process.stderr.write(`[MCP STDIO Bridge] Could not persist identity (${err.message}); using in-memory id\n`);
  }
  return id;
}

let configuredIdentity;
try {
  configuredIdentity = configuredAgentIdentity();
} catch (error) {
  process.stderr.write(`[MCP STDIO Bridge] Identity configuration error: ${error.message}\n`);
  process.exit(2);
}

if (HYTHE_DISTRIBUTION && !configuredIdentity) {
  process.stderr.write(
    '[MCP STDIO Bridge] Identity configuration error: HYTHE_AGENT_ID is required '
    + '(ENGRAM_AGENT_ID is accepted as a legacy alias).\n'
  );
  process.exit(2);
}

let currentFrom = configuredIdentity?.value || loadOrCreateStableFrom();
let identityGenerated = !configuredIdentity;
const identityLocked = Boolean(configuredIdentity);
let currentName = process.env.AGENT_NAME || process.env.MCP_AGENT_NAME || `stdio-bridge-${shortHost}`;
const DEFAULT_CAPABILITIES = ['mcp-client', 'bridge', 'ai-to-ai-messaging'];
let currentCapabilities = DEFAULT_CAPABILITIES.slice();

// Create readline interface for STDIO only after identity validation. Invalid
// or conflicting aliases fail before the bridge can forward any request.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Track message IDs to handle async responses
const pendingRequests = new Map();
let nextId = 1;

function buildHeaders(payload) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  if (process.env.API_KEY) headers['x-api-key'] = process.env.API_KEY;
  return headers;
}

function postJsonRpc(message, { onComplete, suppressLog = false } = {}) {
  try {
    const payload = JSON.stringify(message);
    const options = {
      hostname: SERVER_HOSTNAME,
      port: SERVER_PORT,
      path: '/mcp',
      method: 'POST',
      headers: buildHeaders(payload)
    };

    const req = http.request(options, (res) => {
      let buff = '';
      res.on('data', chunk => { buff += chunk; });
      res.on('end', () => {
        if (!suppressLog && buff) {
          try {
            const parsed = JSON.parse(buff);
            if (onComplete) onComplete(null, parsed);
          } catch (_) {
            if (onComplete) onComplete(null, buff);
          }
        } else if (onComplete) {
          onComplete(null, null);
        }
      });
    });
    req.on('error', (err) => {
      if (!suppressLog) {
        process.stderr.write(`[MCP STDIO Bridge] Auxiliary request error: ${err.message}\n`);
      }
      if (onComplete) onComplete(err);
    });
    req.write(payload);
    req.end();
  } catch (err) {
    process.stderr.write(`[MCP STDIO Bridge] Failed to send auxiliary request: ${err.message}\n`);
    if (onComplete) onComplete(err);
  }
}

function registerCurrentAgent(extraMetadata = {}) {
  const metadata = {
    pid: process.pid,
    generated: identityGenerated,
    version: '1.0.0',
    bridge: 'mcp-stdio-http',
    host: shortHost,
    ...extraMetadata
  };

  const registerMsg = {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: {
      name: 'register_agent',
      arguments: {
        agentId: currentFrom,
        name: currentName,
        capabilities: currentCapabilities,
        metadata
      }
    }
  };

  postJsonRpc(registerMsg, {
    suppressLog: true,
    onComplete: (err) => {
      if (err) {
        process.stderr.write(`[MCP STDIO Bridge] Registration error: ${err.message}\n`);
      } else {
        process.stderr.write(`[MCP STDIO Bridge] Registered agentId=${currentFrom} name=${currentName}\n`);
      }
    }
  });
}

function handleBridgeCommand(command) {
  if (!command || typeof command !== 'object') return;

  const previousAgentId = currentFrom;
  if (command.agentId != null) {
    const requestedAgentId = normalizeAgentId(command.agentId, 'bridgeCommand.agentId');
    if (identityLocked && requestedAgentId !== currentFrom) {
      throw new Error('refusing to replace the configured agent identity');
    }
    currentFrom = requestedAgentId;
    identityGenerated = false;
  }

  if (command.name && typeof command.name === 'string' && command.name.trim().length > 0) {
    currentName = command.name.trim();
  }

  if (Array.isArray(command.capabilities) && command.capabilities.length > 0) {
    currentCapabilities = command.capabilities.map(cap => String(cap));
  }

  const autoRegister = command.autoRegister !== false;
  const metadata = {
    ...(command.metadata && typeof command.metadata === 'object' ? command.metadata : {}),
    previousAgentId
  };

  process.stderr.write(`[MCP STDIO Bridge] Identity updated → agentId=${currentFrom} name=${currentName}\n`);

  if (autoRegister) {
    registerCurrentAgent(metadata);
  }
}

function rejectInvalidParams(originalId, message) {
  process.stderr.write(`[MCP STDIO Bridge] Rejected request: ${message}\n`);
  if (originalId === undefined) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: originalId,
    error: { code: -32602, message },
  }) + '\n');
}

function bindToolIdentity(serverMessage, originalId) {
  if (serverMessage.method !== 'tools/call' || !serverMessage.params) return true;

  const toolName = serverMessage.params.name;
  const bindsAgentId = AGENT_ID_BOUND_TOOLS.has(toolName);
  const bindsSender = toolName === 'send_ai_message';
  if (!bindsAgentId && !bindsSender) return true;

  const args = serverMessage.params.arguments == null
    ? {}
    : serverMessage.params.arguments;
  if (typeof args !== 'object' || Array.isArray(args)) {
    rejectInvalidParams(originalId, `${toolName} arguments must be an object`);
    return false;
  }

  if (bindsSender) {
    if (args.from != null) {
      let explicitFrom;
      try {
        explicitFrom = normalizeAgentId(args.from, 'send_ai_message.from');
      } catch (error) {
        rejectInvalidParams(originalId, error.message);
        return false;
      }
      if (explicitFrom !== currentFrom) {
        rejectInvalidParams(
          originalId,
          'send_ai_message sender identity does not match the bridge-bound identity'
        );
        return false;
      }
    } else {
      process.stderr.write(`[MCP STDIO Bridge] Using bound sender identity: ${currentFrom}\n`);
    }

    serverMessage.params = {
      ...serverMessage.params,
      arguments: { ...args, from: currentFrom },
    };
    return true;
  }

  if (args.agentId != null) {
    let explicitAgentId;
    try {
      explicitAgentId = normalizeAgentId(args.agentId, `${toolName}.agentId`);
    } catch (error) {
      rejectInvalidParams(originalId, error.message);
      return false;
    }
    if (explicitAgentId !== currentFrom) {
      rejectInvalidParams(
        originalId,
        `${toolName} agent identity does not match the bridge-bound identity`
      );
      return false;
    }
  }

  serverMessage.params = {
    ...serverMessage.params,
    arguments: { ...args, agentId: currentFrom },
  };
  return true;
}

// Oversized-message resource handles carry the exact recipient as their
// middle segment: engram://message/<scope>/<recipient>/<message>. A bridge
// with a fixed lane identity rejects foreign and legacy recipient-unbound
// handles before any HTTP request. This is local defense in depth; the
// shared-key HTTP server still treats a correctly formed URI as a bearer
// capability and independently verifies its tenant+scope+recipient+id tuple.
function bindMessageResourceIdentity(serverMessage, originalId) {
  if (serverMessage.method !== 'resources/read') return true;

  const uri = serverMessage.params && typeof serverMessage.params === 'object'
    ? serverMessage.params.uri
    : undefined;
  if (typeof uri !== 'string' || !uri.startsWith('engram://message/')) return true;

  const encodedSegments = uri.slice('engram://message/'.length).split('/');
  if (
    encodedSegments.length !== 3
    || encodedSegments.some((segment) => !ENGRAM_URI_SEGMENT_PATTERN.test(segment))
  ) {
    rejectInvalidParams(originalId, 'message resource URI must bind scope, recipient, and message id');
    return false;
  }

  let recipientAgentId;
  try {
    recipientAgentId = normalizeAgentId(decodeURIComponent(encodedSegments[1]), 'message resource recipient');
  } catch (error) {
    rejectInvalidParams(originalId, error.message);
    return false;
  }
  if (recipientAgentId !== currentFrom) {
    rejectInvalidParams(
      originalId,
      'message resource recipient does not match the bridge-bound identity'
    );
    return false;
  }
  return true;
}

// Handle incoming STDIO messages from Claude Desktop
rl.on('line', (line) => {
  if (!line.trim()) return;
  
  try {
    // Parse the JSON-RPC message from Claude Desktop
    const message = JSON.parse(line);
    
    // Store original ID for response mapping
    const originalId = message.id;
    
    // Handle initialization specially
    if (message.method === 'initialize') {
      // Return our own initialization response
      const response = {
        jsonrpc: '2.0',
        id: originalId,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            prompts: {},
            resources: {}
          },
          serverInfo: {
            name: SERVER_INFO_NAME,
            version: '1.0.0'
          }
        }
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      
      // Also forward to server to initialize it
      const serverMessage = {...message};
      serverMessage.id = nextId++;
      pendingRequests.set(serverMessage.id, {originalId, isInit: true});
      
      const postData = JSON.stringify(serverMessage);
      const options = {
        hostname: SERVER_HOSTNAME,
        port: SERVER_PORT,
        path: '/mcp',
        method: 'POST',
        headers: (() => {
          const h = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          };
          if (process.env.API_KEY) h['x-api-key'] = process.env.API_KEY;
          return h;
        })()
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // Server initialized, but we already responded to Claude Desktop
          process.stderr.write(`[MCP STDIO Bridge] Server initialized successfully\n`);

          // Auto-register this bridge identity
          registerCurrentAgent({ source: 'auto-init' });
        });
      });
      req.on('error', (error) => {
        process.stderr.write(`[MCP STDIO Bridge] Init error: ${error.message}\n`);
      });
      req.write(postData);
      req.end();
      return;
    }
    
    // Handle notifications (no response needed)
    if (message.method === 'notifications/initialized') {
      return; // Just acknowledge silently
    }
    
    // Handle prompts/list
    if (message.method === 'prompts/list') {
      const response = {
        jsonrpc: '2.0',
        id: originalId,
        result: { prompts: [] }
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }
    
    // Handle resources/list
    if (message.method === 'resources/list') {
      const response = {
        jsonrpc: '2.0',
        id: originalId,
        result: { resources: [] }
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }
    
    // Forward all other messages to HTTP MCP server. Enforce sender binding
    // before allocating a server request id so rejected impersonation attempts
    // never enter the pending map and never reach the HTTP server.
    const serverMessage = {...message};
    if (!bindToolIdentity(serverMessage, originalId)) return;
    if (!bindMessageResourceIdentity(serverMessage, originalId)) return;

    if (originalId !== undefined) {
      serverMessage.id = nextId++;
      pendingRequests.set(serverMessage.id, {originalId, isInit: false});
    }

    const postData = JSON.stringify(serverMessage);
    
    const options = {
      hostname: SERVER_HOSTNAME,
      port: SERVER_PORT,
      path: '/mcp',
      method: 'POST',
      headers: (() => {
        const h = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        };
        if (process.env.API_KEY) h['x-api-key'] = process.env.API_KEY;
        return h;
      })()
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const serverResponseId = response.id;

          if (response.result && response.result.bridgeCommand) {
            try {
              handleBridgeCommand(response.result.bridgeCommand);
            } catch (commandErr) {
              process.stderr.write(`[MCP STDIO Bridge] Bridge command error: ${commandErr.message}\n`);
            }
            delete response.result.bridgeCommand;
          }

          // Map server ID back to Claude Desktop's original ID
          if (serverResponseId !== undefined && pendingRequests.has(serverResponseId)) {
            const {originalId, isInit} = pendingRequests.get(serverResponseId);
            if (!isInit) { // Don't send duplicate init response
              response.id = originalId;
              process.stdout.write(JSON.stringify(response) + '\n');
            }
            pendingRequests.delete(serverResponseId);
          } else {
            // Send as-is if no mapping
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        } catch (e) {
          // If not JSON, send as-is
          process.stdout.write(data + '\n');
        }
      });
    });
    
    req.on('error', (error) => {
      process.stderr.write(`[MCP STDIO Bridge] Request error: ${error.message}\n`);
      if (originalId !== undefined) {
        const errorResponse = {
          jsonrpc: '2.0',
          id: originalId,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          }
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    });
    
    req.write(postData);
    req.end();
    
  } catch (error) {
    process.stderr.write(`[MCP STDIO Bridge] Parse error: ${error.message}\n`);
  }
});

// Handle process termination
process.on('SIGINT', () => {
  process.stderr.write('[MCP STDIO Bridge] Shutting down...\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.stderr.write('[MCP STDIO Bridge] Terminated\n');
  process.exit(0);
});

// Log ready to stderr
process.stderr.write(`[MCP STDIO Bridge] Ready - connecting to ${SERVER_HOSTNAME}:${SERVER_PORT}\n`);
