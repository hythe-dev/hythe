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

// Create readline interface for STDIO
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Track message IDs to handle async responses
const pendingRequests = new Map();
let nextId = 1;

// MCP target. Defaults to localhost:6174, overridable via env.
const SERVER_HOSTNAME = process.env.MCP_HOST || 'localhost';
const SERVER_PORT = parseInt(process.env.MCP_PORT || '6174', 10);
// Default sender for AI messages.
const shortHost = os.hostname().split('.')?.[0] || 'host';
const ENV_FROM = process.env.FROM || process.env.MCP_FROM;

// Stable per-host identity. Previously this minted a NEW id per process
// (`agent-<host>-<pid>-<ts>`) and auto-registered it, so every CLI launch left
// a throwaway agent row forever (~1,949 of 2,003 registrations on the live DB).
// Instead, persist one stable id per host to a cache file and reuse it across
// processes, so reconnects keep the same identity and the registry stops
// growing. Env FROM/MCP_FROM still overrides everything.
function loadOrCreateStableFrom() {
  const dir = process.env.MCP_BRIDGE_STATE_DIR
    || path.join(os.homedir() || os.tmpdir(), '.neural-mcp');
  const file = path.join(dir, `bridge-identity-${shortHost}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.agentId === 'string' && saved.agentId.length > 0) {
      return saved.agentId;
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

let currentFrom = ENV_FROM || loadOrCreateStableFrom();
let identityGenerated = !ENV_FROM;
let currentName = process.env.AGENT_NAME || process.env.MCP_AGENT_NAME || `stdio-bridge-${shortHost}`;
const DEFAULT_CAPABILITIES = ['mcp-client', 'bridge', 'ai-to-ai-messaging'];
let currentCapabilities = DEFAULT_CAPABILITIES.slice();

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
  if (command.agentId && typeof command.agentId === 'string' && command.agentId.trim().length > 0) {
    currentFrom = command.agentId.trim();
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
    
    // Forward all other messages to HTTP MCP server
    const serverMessage = {...message};
    if (originalId !== undefined) {
      serverMessage.id = nextId++;
      pendingRequests.set(serverMessage.id, {originalId, isInit: false});
    }

    // Small enhancement: inject default sender for send_ai_message if not provided
    try {
      if (
        serverMessage.method === 'tools/call' &&
        serverMessage.params &&
        serverMessage.params.name === 'send_ai_message'
      ) {
        const args = serverMessage.params.arguments || {};
        if (currentFrom && args && typeof args === 'object' && args.from == null) {
          serverMessage.params.arguments = { ...args, from: currentFrom };
          process.stderr.write(`[MCP STDIO Bridge] Using default sender identity: ${currentFrom}\n`);
        }
      }
    } catch (_) {
      // Non-fatal; continue without injection
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
