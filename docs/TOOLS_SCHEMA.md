# Unified MCP Tool Schemas

> Generated from src/shared/toolSchemas.ts (single source of truth).

### create_entities
Create multiple new entities in the knowledge graph

Parameters

```json
{
  "type": "object",
  "properties": {
    "entities": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The name of the entity"
          },
          "entityType": {
            "type": "string",
            "description": "The type of the entity"
          },
          "aliases": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Optional natural-language aliases that should resolve to this canonical entity"
          },
          "agentBootstrap": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Optional agent-facing bootstrap instructions for future sessions"
          },
          "metadata": {
            "type": "object",
            "description": "Optional structured metadata for agent consumers"
          },
          "observations": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "An array of observation contents associated with the entity"
          }
        },
        "required": [
          "name",
          "entityType",
          "observations"
        ]
      }
    }
  },
  "required": [
    "entities"
  ]
}
```

### add_observations
Add new observations to existing entities with automatic vector embedding and graph updates. Supports mode:"replace-current" (alias supersedesLatest:true) to atomically supersede the entity's current observation server-side — the recommended way to maintain a one-current-observation entity without fetching the prior observation id.

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Source agent ID for observation attribution. With per-agent proof the server injects and authorizes the exact authenticated principal; observe-mode legacy calls may still supply it explicitly. The effective value becomes shared_memory.created_by."
    },
    "mode": {
      "type": "string",
      "enum": [
        "append",
        "replace-current"
      ],
      "description": "Default write mode for every observation in this call. \"append\" (default) adds without superseding; \"replace-current\" makes the server resolve the entity's current observation and supersede it. Per-observation mode overrides this."
    },
    "supersedesLatest": {
      "type": "boolean",
      "description": "Alias for mode:\"replace-current\" applied to every observation in this call."
    },
    "observations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "entityName": {
            "type": "string",
            "description": "The name of the entity to add the observations to"
          },
          "contents": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "An array of observation contents to add"
          },
          "metadata": {
            "type": "object",
            "description": "Optional structured metadata for agents, e.g. {kind, canonicalFact, supersedes, appliesTo, severity, status}"
          },
          "kind": {
            "type": "string",
            "description": "Optional shorthand for metadata.kind, e.g. correction, handoff, decision"
          },
          "canonicalFact": {
            "type": "string",
            "description": "Optional shorthand for metadata.canonicalFact when kind=correction"
          },
          "mode": {
            "type": "string",
            "enum": [
              "append",
              "replace-current"
            ],
            "description": "Write mode for this observation. \"replace-current\": the server resolves the entity's current (newest non-superseded) observation and records it in this observation's supersedes — no client round-trip for the prior id. Overrides the call-level mode."
          },
          "supersedesLatest": {
            "type": "boolean",
            "description": "Alias for mode:\"replace-current\" on this observation."
          },
          "supersedes": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Optional observation IDs or handles superseded by this observation (merged with the server-resolved id when mode is \"replace-current\")"
          },
          "appliesTo": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Optional entity names this observation/correction applies to"
          },
          "severity": {
            "type": "string",
            "description": "Optional agent-facing importance, e.g. low, normal, high, critical"
          }
        },
        "required": [
          "entityName",
          "contents"
        ]
      }
    }
  },
  "required": [
    "observations"
  ]
}
```

### get_current_observation
Return the single authoritative (current) observation for an entity: the newest observation not superseded by any other. Resolves the supersedes chain server-side via the entity lookup index — no history scan, works for entities with thousands of observations. Returns id, timestamp, kind, canonicalFact, full contents, and metadata; current:null when the entity has no observations.

Parameters

```json
{
  "type": "object",
  "properties": {
    "entity": {
      "type": "string",
      "description": "Entity name to resolve the current observation for (aliases accepted: entityName, name)"
    },
    "entityName": {
      "type": "string",
      "description": "Alias for entity"
    },
    "name": {
      "type": "string",
      "description": "Alias for entity"
    },
    "windowSize": {
      "type": "number",
      "description": "Advanced: how many newest observations to consider when resolving supersession (default 25, max 100). Only raise this if an entity accumulates many un-superseded concurrent writers."
    }
  },
  "required": []
}
```

### compact_memory
Analyze and reclaim storage bloat (ENG-2). Classes: "index-diet" (rebuild the derived graph_lookup_keys index under the current extraction policy), "superseded" (retire explicitly-superseded observations to restorable trash — marked-only, never guesses staleness, never touches an entity's current observation), "vec-orphans" (drop vector rows whose source memory is gone), "message-archive" (flag read messages older than the cutoff as archived). mode:"dry-run" (default) only reports what WOULD be reclaimed; mode:"execute" additionally requires confirm:true and admin-equivalent authorization. Deleted pages are not returned to the OS — a separate offline VACUUM is required to shrink the file.

Parameters

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "dry-run",
        "execute"
      ],
      "description": "dry-run (default): report-only, no writes. execute: perform reclaim for the selected classes (requires confirm:true)."
    },
    "classes": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "index-diet",
          "superseded",
          "vec-orphans",
          "message-archive"
        ]
      },
      "description": "Which reclaim classes to analyze/execute. Default: all four."
    },
    "confirm": {
      "type": "boolean",
      "description": "Required true for mode:\"execute\" — an explicit second key for destructive operation."
    },
    "olderThanDays": {
      "type": "number",
      "description": "message-archive cutoff: archive read messages older than this many days (default 14, min 1)."
    },
    "spotCheckKeys": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "index-diet verification: lookup keys that must survive the diet; the report shows before/after row counts for each."
    },
    "reason": {
      "type": "string",
      "description": "Recorded in trash entries and the audit log."
    }
  },
  "required": []
}
```

### create_relations
Create multiple new relations between entities in the knowledge graph

Parameters

```json
{
  "type": "object",
  "properties": {
    "relations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string",
            "description": "The name of the entity where the relation starts"
          },
          "to": {
            "type": "string",
            "description": "The name of the entity where the relation ends"
          },
          "relationType": {
            "type": "string",
            "description": "The type of the relation"
          },
          "properties": {
            "type": "object",
            "description": "Optional relation properties"
          }
        },
        "required": [
          "from",
          "to",
          "relationType"
        ]
      }
    }
  },
  "required": [
    "relations"
  ]
}
```

### read_graph
Read the knowledge graph in BOUNDED pages (entities, relations, and optionally observations). Defaults to a capped page and EXCLUDES observations unless requested, so a broad read can never dump the whole graph. Use limit/offset to paginate and since to fetch only recent rows; the response includes accurate totals + nextOffset. For a focused view around one entity, prefer get_entity_neighborhood.

Parameters

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "Max rows returned PER section (entities/relations/observations). Default 100, server hard cap 500.",
      "default": 100
    },
    "offset": {
      "type": "number",
      "description": "Skip this many rows per section for pagination (use nextOffset from a previous response).",
      "default": 0
    },
    "since": {
      "type": "string",
      "description": "Optional ISO timestamp; include only rows created at or after this time."
    },
    "includeObservations": {
      "type": "boolean",
      "description": "Include the observations section (the largest). Default false to keep responses small.",
      "default": false
    }
  }
}
```

### get_entity_neighborhood
Bounded local-graph view around ONE entity: the entity plus its directly-related entities and the relations among them, out to a small depth (1-2 hops). The safe, focused alternative to read_graph — hard-capped node/edge counts with truncated flags. Use it to answer "what is connected to X?".

Parameters

```json
{
  "type": "object",
  "properties": {
    "entity": {
      "type": "string",
      "description": "Name of the center entity (exact match)."
    },
    "depth": {
      "type": "number",
      "description": "Hop distance to expand: 1 (direct neighbors) or 2. Default 1, max 2.",
      "default": 1
    },
    "limit": {
      "type": "number",
      "description": "Hard cap on neighbor nodes AND on edges returned. Default 50, max 200.",
      "default": 50
    },
    "includeObservations": {
      "type": "boolean",
      "description": "Include up to `limit` recent observations for the center entity. Default false.",
      "default": false
    }
  },
  "required": [
    "entity"
  ]
}
```

### get_entity_backlinks
Bounded backlink view for ONE entity. Returns relation rows that point TO the entity, plus optional outgoing links for comparison. Inspired by Obsidian backlinks, but read from the SQLite knowledge graph.

Parameters

```json
{
  "type": "object",
  "properties": {
    "entity": {
      "type": "string",
      "description": "Name of the target entity (case-insensitive exact match)."
    },
    "limit": {
      "type": "number",
      "description": "Hard cap on incoming and outgoing links returned. Default 50, max 200.",
      "default": 50
    },
    "includeOutgoing": {
      "type": "boolean",
      "description": "Also include outgoing links from this entity. Default false.",
      "default": false
    }
  },
  "required": [
    "entity"
  ]
}
```

### send_ai_message
Send messages to AI agents (direct, capability-based, or broadcast)

Parameters

```json
{
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "description": "Target AI agent ID (use \"*\" for broadcast)"
    },
    "agentId": {
      "type": "string",
      "description": "DEPRECATED: Target alias for `to`"
    },
    "from": {
      "type": "string",
      "description": "Sender agent ID (required for correct attribution)"
    },
    "content": {
      "type": "string",
      "description": "Message content"
    },
    "message": {
      "type": "string",
      "description": "DEPRECATED: Alias for `content`"
    },
    "toCapabilities": {
      "type": "array",
      "description": "Select recipients whose capabilities include ALL provided",
      "items": {
        "type": "string"
      }
    },
    "capabilities": {
      "type": "array",
      "description": "Alias for `toCapabilities`",
      "items": {
        "type": "string"
      }
    },
    "broadcast": {
      "type": "boolean",
      "description": "Send to all registered agents",
      "default": false
    },
    "excludeSelf": {
      "type": "boolean",
      "description": "Exclude sender when broadcasting/selecting",
      "default": true
    },
    "messageType": {
      "type": "string",
      "enum": [
        "info",
        "task",
        "query",
        "response",
        "collaboration"
      ],
      "description": "Type of message",
      "default": "info"
    },
    "priority": {
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high",
        "urgent"
      ],
      "description": "Message priority",
      "default": "normal"
    },
    "supersedes": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 100,
      "description": "Older message IDs this message replaces. Only messages from the same sender to the same recipient in the same tenant are superseded."
    }
  },
  "required": [
    "content",
    "from"
  ]
}
```

### get_ai_messages
Retrieve messages for the calling agent's exact inbox with filtering and real offset pagination. Identity-bound client bridges require agentId to match the configured lane identity. The response reports the true total matching the filters plus hasMore/nextOffset. IMPORTANT: For routine inbox checks, just pass agentId — the defaults (unreadOnly: true, compact: true, limit: 5, offset: 0) return the latest unread messages. Do NOT use the since filter for inbox checks; it often causes missed messages when the timestamp is stale.

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "AI agent ID to get messages for"
    },
    "from": {
      "type": "string",
      "description": "Filter by sender agent ID (e.g. \"codex\", \"claude-code-sm\")"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "description": "Maximum number of messages (server hard cap: 20)",
      "default": 5
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "description": "Skip this many matching messages. Use nextOffset from the previous response. When unreadOnly and markAsRead are both true, nextOffset resets to 0 while unread matches remain because each returned page leaves the unread result set.",
      "default": 0
    },
    "messageType": {
      "type": "string",
      "enum": [
        "info",
        "task",
        "query",
        "response",
        "collaboration"
      ],
      "description": "Filter by message type"
    },
    "since": {
      "type": "string",
      "description": "ADVANCED ONLY — ISO timestamp for time-range queries. Do NOT use for routine inbox checks; use unreadOnly instead. A stale timestamp will cause missed messages."
    },
    "unreadOnly": {
      "type": "boolean",
      "description": "Only return unread messages (default: true). This is the recommended way to check your own exact inbox.",
      "default": true
    },
    "compact": {
      "type": "boolean",
      "description": "Return summaries only without full content (use get_message_detail for full content)",
      "default": true
    },
    "markAsRead": {
      "type": "boolean",
      "description": "Mark returned messages as read after retrieval",
      "default": false
    },
    "includeArchived": {
      "type": "boolean",
      "description": "Include archived messages in results (excluded by default)",
      "default": false
    },
    "includeSuperseded": {
      "type": "boolean",
      "description": "Include messages replaced by newer messages (excluded by default)",
      "default": false
    }
  },
  "required": [
    "agentId"
  ]
}
```

### register_agent
Register or refresh an AI agent in the collaboration system. Optional TTL/expiresAt metadata lets ephemeral agents expire without schema migration.

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Unique agent identifier"
    },
    "name": {
      "type": "string",
      "description": "Human-readable agent name"
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "List of agent capabilities"
    },
    "endpoint": {
      "type": "string",
      "description": "Agent communication endpoint"
    },
    "ttlSeconds": {
      "type": "number",
      "description": "Optional time-to-live in seconds. Stored in metadata and reflected as expiresAt."
    },
    "expiresAt": {
      "type": "string",
      "description": "Optional ISO timestamp when this registration should be treated as expired."
    },
    "metadata": {
      "type": "object",
      "description": "Additional agent metadata"
    }
  },
  "required": [
    "agentId",
    "name",
    "capabilities"
  ]
}
```

### unregister_agent
Soft-unregister an agent registration by marking it inactive and recording lifecycle audit metadata. Does not delete rows.

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Agent identifier to unregister"
    },
    "reason": {
      "type": "string",
      "description": "Optional reason recorded in registration metadata"
    }
  },
  "required": [
    "agentId"
  ]
}
```

### gc_agent_registrations
Dry-run-first garbage collection for expired or stale inactive agent registrations. Deletes only when dryRun is false.

Parameters

```json
{
  "type": "object",
  "properties": {
    "dryRun": {
      "type": "boolean",
      "description": "If true, report matching rows without deleting them",
      "default": true
    },
    "deleteExpired": {
      "type": "boolean",
      "description": "Include registrations whose metadata.expiresAt is in the past",
      "default": true
    },
    "inactiveOlderThanSeconds": {
      "type": "number",
      "description": "Also include inactive rows whose updated_at is older than this many seconds"
    },
    "limit": {
      "type": "number",
      "description": "Maximum rows to delete or report (server hard cap 500)",
      "default": 100
    }
  }
}
```

### set_agent_identity
Temporarily disabled during migration to tenant-scoped stable principals. Calls fail without changing identity history; register an exact handle with register_agent instead.

Parameters

```json
{
  "type": "object",
  "properties": {
    "currentAgentId": {
      "type": "string",
      "description": "Existing agent identifier (defaults to caller)"
    },
    "newAgentId": {
      "type": "string",
      "description": "Replacement agent identifier"
    },
    "newName": {
      "type": "string",
      "description": "Replacement agent display name"
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional capability list to upsert during identity update"
    },
    "metadata": {
      "type": "object",
      "description": "Optional metadata to store alongside the identity change"
    },
    "autoRegister": {
      "type": "boolean",
      "description": "Automatically re-register the MCP bridge with the new identity",
      "default": true
    }
  },
  "required": [
    "newAgentId"
  ]
}
```

### get_agent_status
Get comprehensive status and health information for AI agents

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Specific agent ID, or omit for all agents"
    },
    "groupByCanonical": {
      "type": "boolean",
      "description": "Include canonical-agent rollups and aliases in addition to raw registrations",
      "default": true
    },
    "limit": {
      "type": "number",
      "description": "Max raw registrations to return when listing all agents (server hard cap: 200). The canonical-agent rollup always covers ALL registrations regardless of this limit.",
      "default": 50
    },
    "offset": {
      "type": "number",
      "description": "Skip this many raw registrations for pagination (use nextOffset from a previous response).",
      "default": 0
    }
  }
}
```

### search_entities
Advanced federated search across graph, vectors, and cache. AGENT TIP: for a KNOWN entity/project name, pass searchType=exact — it is fast, precise, and name-anchored; hybrid/semantic is a bounded, lower-precision supplement best for fuzzy/exploratory queries (entity & observation hits are ranked above ai_message chatter). Returns compact summaries by default (use get_entity_detail for full content). Supports pagination, relevance/recency ordering, and entity/memory-type scoping.

Parameters

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Query against names, types, observations"
    },
    "searchType": {
      "type": "string",
      "enum": [
        "semantic",
        "exact",
        "graph",
        "hybrid"
      ],
      "default": "hybrid"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of results per page",
      "default": 50
    },
    "compact": {
      "type": "boolean",
      "description": "Return compact summaries for large entities (use get_entity_detail for full content)",
      "default": true
    },
    "offset": {
      "type": "number",
      "description": "Skip this many results for pagination (use nextOffset from previous response)",
      "default": 0
    },
    "maxResponseSize": {
      "type": "number",
      "description": "Maximum response size in characters (budget enforcement)",
      "default": 40000
    },
    "memoryType": {
      "type": "string",
      "description": "Filter results by memory type (e.g. \"individual\", \"shared\")"
    },
    "agentFilter": {
      "type": "string",
      "description": "Filter results by agent/source ID"
    },
    "sortBy": {
      "type": "string",
      "enum": [
        "relevance",
        "recency"
      ],
      "description": "Result ordering. Relevance preserves the default ranking; recency sorts newest first before pagination.",
      "default": "relevance"
    },
    "canonicalEntityKey": {
      "type": "string",
      "description": "Restrict results to one canonical entity and its direct observations/relations."
    },
    "memoryTypes": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Restrict results to storage memory types such as entity, observation, relation, or ai_message."
    },
    "includeRedundantRepresentations": {
      "type": "boolean",
      "description": "Include dual-storage representations that are hidden by default, such as an entity row matched only through embedded inline observation text when the materialized observation row is also returned",
      "default": false
    }
  },
  "required": [
    "query"
  ]
}
```

### discover_related_context
Read-only related-knowledge discovery for an exact project/task scope. Automatically retrieves vector candidates, reranks them with bounded one/two-hop graph paths, and explains currentness, evidence references, provenance, and score components. It never creates relations or changes memory; use create_relations separately only after validating a proposed relationship.

Parameters

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "description": "Exact canonical name or registered alias for at least one project/task entity. Unknown or ambiguous scopes fail closed before broad retrieval.",
      "properties": {
        "project": {
          "type": "string",
          "minLength": 1
        },
        "task": {
          "type": "string",
          "minLength": 1
        }
      },
      "anyOf": [
        {
          "required": [
            "project"
          ]
        },
        {
          "required": [
            "task"
          ]
        }
      ]
    },
    "intent": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000,
      "description": "The current goal or question used to discover reusable knowledge."
    },
    "candidateLimit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 25,
      "default": 10,
      "description": "Maximum ranked entities returned (server hard cap: 25)."
    },
    "graphDepth": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2,
      "default": 1,
      "description": "Maximum graph path depth used for reranking (server hard cap: 2)."
    },
    "budget": {
      "type": "integer",
      "minimum": 256,
      "maximum": 12000,
      "default": 3000,
      "description": "Hard token-estimate ceiling for the serialized response."
    }
  },
  "required": [
    "scope",
    "intent"
  ]
}
```

### get_agent_context
Retrieve a tiered context bundle for an agent, optionally scoped to a project. Returns identity, project state, unread messages, guardrails, and handoff flags.

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Agent ID to build context for"
    },
    "projectId": {
      "type": "string",
      "description": "Optional project scope (enables WARM/COLD tiers and handoff flag)"
    },
    "depth": {
      "type": "string",
      "enum": [
        "hot",
        "warm",
        "cold"
      ],
      "description": "Context depth: hot (identity+messages+guardrails), warm (hot+project 30d), cold (everything). Defaults to warm if projectId provided, else hot."
    },
    "maxTokens": {
      "type": "integer",
      "minimum": 1,
      "description": "Requested hard ceiling on the server's serialized-size token estimate. Requests below the minimal identity-envelope budget are raised to the reported effectiveMaxTokens; all other estimates stay at or below the request. Default: 4000.",
      "default": 4000
    },
    "userId": {
      "type": "string",
      "description": "Optional user ID to include HOT tier user profile block. Overridden by JWT userId when authenticated."
    }
  },
  "required": [
    "agentId"
  ]
}
```

### begin_session
Compatibility wrapper over resume (Engram v1 B2, TOOL-COMPATIBILITY-MAP.md). Rebuilds working context for a scope; NEVER auto-consumes handoffs — acknowledgement is explicit via ackHandoffIds. Accepts the wrapper shape {agentId, scope:{project|task}, budget, ackHandoffIds?} or the pinned legacy shape {agentId, projectId, maxTokens?, userId?} (auto-adapted: projectId→scope.project, maxTokens→budget, userId deprecated). Legacy side effects are gone — the wrapper only resumes and acks. Prefer resume for new callers.

Parameters

```json
{
  "type": "object",
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "agentId",
        "scope",
        "budget"
      ],
      "properties": {
        "agentId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "pattern": "^[A-Za-z0-9_.:-]+$"
        },
        "scope": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "project": {
              "type": "string",
              "minLength": 1
            },
            "task": {
              "type": "string",
              "minLength": 1
            }
          },
          "anyOf": [
            {
              "required": [
                "project"
              ]
            },
            {
              "required": [
                "task"
              ]
            }
          ]
        },
        "budget": {
          "type": "integer",
          "minimum": 256
        },
        "ackHandoffIds": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Handoffs this agent explicitly acknowledges (per-agent, per-tenant; each must exist in the same tenant or the whole call fails closed)."
        }
      }
    },
    {
      "type": "object",
      "required": [
        "agentId",
        "projectId"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "scope"
            ]
          },
          {
            "required": [
              "budget"
            ]
          },
          {
            "required": [
              "ackHandoffIds"
            ]
          }
        ]
      },
      "properties": {
        "agentId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "pattern": "^[A-Za-z0-9_.:-]+$",
          "description": "Agent opening the session"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "description": "Adapted to scope.project by the wrapper"
        },
        "maxTokens": {
          "type": "integer",
          "minimum": 1,
          "description": "Adapted to budget (omitted = 4000; explicit values below 256 are clamped to 256)"
        },
        "userId": {
          "type": "string",
          "description": "DEPRECATED; honored outside resume until the v1 cut"
        }
      }
    }
  ]
}
```

### end_session
Compatibility wrapper over checkpoint (Engram v1 B2, TOOL-COMPATIBILITY-MAP.md) — end_session IS checkpoint: pass {agentId, scope:{project|task}, expectedRevision, idempotencyKey, state, factChanges?, loopChanges?}. The legacy {projectId, summary, openItems} shape is RETIRED and returns a migration error. Legacy side effects are gone — the wrapper only checkpoints. Prefer checkpoint for new callers.

Parameters

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "scope",
    "expectedRevision",
    "idempotencyKey"
  ],
  "properties": {
    "agentId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "pattern": "^[A-Za-z0-9_.:-]+$",
      "description": "ASSERTED exact opaque caller identity (platform max 100); case and transport-looking suffixes are identity-significant, and the raw asserted id is preserved in audit metadata."
    },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "project": {
          "type": "string",
          "minLength": 1
        },
        "task": {
          "type": "string",
          "minLength": 1
        }
      },
      "anyOf": [
        {
          "required": [
            "project"
          ]
        },
        {
          "required": [
            "task"
          ]
        }
      ]
    },
    "expectedRevision": {
      "type": [
        "integer",
        "null"
      ],
      "description": "CAS guard; null asserts first write in scope."
    },
    "idempotencyKey": {
      "type": "string",
      "minLength": 8
    },
    "resultVersion": {
      "type": "integer",
      "enum": [
        1,
        2,
        3
      ],
      "description": "Result-shape opt-in. Omit or 1: the frozen v1 result. 2: written/idempotent-replay also return `changes` — the factId/loopId each factChanges[i]/loopChanges[i] materialized to, with a created flag. Bound into the idempotency fingerprint only when 2. 3 (final as of ENG-4 H5; internal until the owner publishes v3): v2 plus the `operation` discriminant (`reconcile`, `record`, `patch`) and its fields; required for any of them."
    },
    "operation": {
      "enum": [
        "write",
        "reconcile",
        "record",
        "patch"
      ],
      "description": "resultVersion 3 only. Absent = legacy write. `reconcile` names the exact live-head set and pointer (CAS), retires every head but the survivor, and resolves divergent values causally. `record` logs fact/loop changes without resending state and `patch` applies an RFC 7396 merge patch to the state; both require expectedRevision to be the POINTED head (conflict otherwise, carrying heads and pointer), take the parent state from its hash-verified payload, and advance the pointer."
    },
    "statePatch": {
      "type": "object",
      "description": "patch only: RFC 7396 merge patch against the verified parent state (null deletes a key; arrays replace wholesale). The result must be a complete valid working state or the call fails closed."
    },
    "acknowledgeRetired": {
      "type": "boolean",
      "description": "resultVersion 3 only: a write extending a RETIRED parent must set true (it never moves the pointer); a reconcile whose survivor descends from retired snapshots must set true (the re-adopted snapshots are recorded as adoptedRetired)."
    },
    "expectedHeads": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "description": "reconcile: the exact set of live head stateIds (order irrelevant)."
    },
    "expectedPointer": {
      "type": [
        "string",
        "null"
      ],
      "description": "reconcile: the current pointer stateId, or null for a scope without one."
    },
    "survivor": {
      "type": "string",
      "minLength": 1,
      "description": "reconcile: the head that becomes the parent; must be in expectedHeads and match expectedRevision."
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "description": "reconcile: required free text."
    },
    "strict": {
      "type": "boolean",
      "description": "reconcile: default true — any unresolved materialized divergent terminal refuses the call. Opaque (unversioned) terminals must be rejected regardless."
    },
    "resolutions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "id",
          "divergentStateId",
          "decision"
        ],
        "properties": {
          "kind": {
            "enum": [
              "fact",
              "loop"
            ]
          },
          "id": {
            "type": "string",
            "minLength": 1
          },
          "divergentStateId": {
            "type": "string",
            "minLength": 1
          },
          "decision": {
            "enum": [
              "accept",
              "reject"
            ]
          },
          "acceptedOrdinal": {
            "type": "integer",
            "minimum": 0
          }
        },
        "allOf": [
          {
            "if": {
              "properties": {
                "decision": {
                  "const": "accept"
                }
              }
            },
            "then": {
              "required": [
                "acceptedOrdinal"
              ]
            }
          },
          {
            "if": {
              "properties": {
                "decision": {
                  "const": "reject"
                }
              }
            },
            "then": {
              "not": {
                "required": [
                  "acceptedOrdinal"
                ]
              }
            }
          }
        ]
      }
    },
    "rejectLineages": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "description": "reconcile: divergent head ids whose every unresolved terminal is rejected (expanded server-side to per-value rejects)."
    },
    "state": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "objective",
        "status",
        "owner",
        "nextActions",
        "blockers",
        "guardrails"
      ],
      "properties": {
        "objective": {
          "type": "string"
        },
        "status": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        },
        "nextActions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "guardrails": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "summary"
        ],
        "properties": {
          "kind": {
            "type": "string"
          },
          "summary": {
            "type": "string"
          },
          "at": {
            "type": "string"
          }
        }
      }
    },
    "factChanges": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "assertion",
          "status",
          "evidenceRefs",
          "sourceRefs"
        ],
        "properties": {
          "factId": {
            "type": "string"
          },
          "assertion": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "subject",
              "predicate",
              "object"
            ],
            "properties": {
              "subject": {
                "type": "string",
                "minLength": 1
              },
              "predicate": {
                "type": "string",
                "minLength": 1
              },
              "object": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "status": {
            "enum": [
              "asserted",
              "verified",
              "disputed",
              "superseded"
            ]
          },
          "evidenceRefs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "sourceRefs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "effectiveAt": {
            "type": "string"
          },
          "contradicts": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      }
    },
    "loopChanges": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "status",
          "nextAction"
        ],
        "properties": {
          "loopId": {
            "type": "string"
          },
          "status": {
            "enum": [
              "open",
              "blocked",
              "closed"
            ]
          },
          "nextAction": {
            "type": "string"
          },
          "owner": {
            "type": "string"
          },
          "dueAt": {
            "type": "string"
          },
          "blockedOn": {
            "type": "string"
          },
          "closeOutcome": {
            "type": "string"
          }
        }
      }
    },
    "evidenceRefs": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "allOf": [
    {
      "if": {
        "not": {
          "required": [
            "resultVersion"
          ],
          "properties": {
            "resultVersion": {
              "const": 3
            }
          }
        }
      },
      "then": {
        "not": {
          "anyOf": [
            {
              "required": [
                "operation"
              ]
            },
            {
              "required": [
                "acknowledgeRetired"
              ]
            },
            {
              "required": [
                "expectedHeads"
              ]
            },
            {
              "required": [
                "expectedPointer"
              ]
            },
            {
              "required": [
                "survivor"
              ]
            },
            {
              "required": [
                "reason"
              ]
            },
            {
              "required": [
                "strict"
              ]
            },
            {
              "required": [
                "resolutions"
              ]
            },
            {
              "required": [
                "rejectLineages"
              ]
            },
            {
              "required": [
                "statePatch"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "not": {
          "required": [
            "operation"
          ],
          "properties": {
            "operation": {
              "enum": [
                "record",
                "patch"
              ]
            }
          }
        }
      },
      "then": {
        "required": [
          "state"
        ],
        "not": {
          "required": [
            "statePatch"
          ]
        }
      }
    },
    {
      "if": {
        "required": [
          "operation"
        ],
        "properties": {
          "operation": {
            "const": "record"
          }
        }
      },
      "then": {
        "not": {
          "anyOf": [
            {
              "required": [
                "state"
              ]
            },
            {
              "required": [
                "statePatch"
              ]
            },
            {
              "required": [
                "acknowledgeRetired"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "required": [
          "operation"
        ],
        "properties": {
          "operation": {
            "const": "patch"
          }
        }
      },
      "then": {
        "required": [
          "statePatch"
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "state"
              ]
            },
            {
              "required": [
                "acknowledgeRetired"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "required": [
          "operation"
        ],
        "properties": {
          "operation": {
            "const": "reconcile"
          }
        }
      },
      "then": {
        "required": [
          "expectedHeads",
          "expectedPointer",
          "survivor",
          "reason"
        ]
      }
    },
    {
      "if": {
        "not": {
          "required": [
            "operation"
          ],
          "properties": {
            "operation": {
              "const": "reconcile"
            }
          }
        }
      },
      "then": {
        "not": {
          "anyOf": [
            {
              "required": [
                "expectedHeads"
              ]
            },
            {
              "required": [
                "expectedPointer"
              ]
            },
            {
              "required": [
                "survivor"
              ]
            },
            {
              "required": [
                "reason"
              ]
            },
            {
              "required": [
                "strict"
              ]
            },
            {
              "required": [
                "resolutions"
              ]
            },
            {
              "required": [
                "rejectLineages"
              ]
            }
          ]
        }
      }
    }
  ]
}
```

### search_nodes
DEPRECATED alias for graph-only search; use search_entities with { searchType: "graph" }

Parameters

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The search query to match"
    }
  },
  "required": [
    "query"
  ]
}
```

### get_user_profile
Get a user profile within the current tenant. Returns timezone, locale, preferences.

Parameters

```json
{
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "description": "User ID to retrieve profile for. Must match authenticated user (JWT) or be provided by service key."
    }
  },
  "required": [
    "userId"
  ]
}
```

### update_user_profile
Update a user profile. Only the profile owner (or a service key) can update. Bumps prefs_version.

Parameters

```json
{
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "description": "User ID to update. Must match authenticated user (JWT) or be provided by service key."
    },
    "displayName": {
      "type": "string",
      "description": "Display name"
    },
    "timezone": {
      "type": "string",
      "description": "IANA timezone string (e.g., America/Chicago)"
    },
    "locale": {
      "type": "string",
      "description": "Locale string (e.g., en-US)"
    },
    "dateFormat": {
      "type": "string",
      "description": "Date format preference"
    },
    "units": {
      "type": "string",
      "description": "Unit system (metric/imperial)"
    },
    "workingHours": {
      "type": "object",
      "description": "Working hours { start, end }",
      "properties": {
        "start": {
          "type": "string"
        },
        "end": {
          "type": "string"
        }
      }
    }
  },
  "required": [
    "userId"
  ]
}
```

### get_message_detail
Retrieve the full content of a single message by ID. Use after scanning compact message list from get_ai_messages.

Parameters

```json
{
  "type": "object",
  "properties": {
    "messageId": {
      "type": "string",
      "description": "The message ID to retrieve full content for"
    },
    "agentId": {
      "type": "string",
      "description": "Agent ID (recipient) — required to prove recipient identity"
    },
    "markAsRead": {
      "type": "boolean",
      "description": "Mark this message as read after retrieval",
      "default": true
    }
  },
  "required": [
    "messageId",
    "agentId"
  ]
}
```

### get_entity_detail
Retrieve full entity content by storage ID, canonical entity name, or alias. `ids` preserves the scan-then-detail workflow; `names` or the singular `entity` input skips the search-then-refetch round trip and returns resolution metadata. STATE SEMANTICS: an entity's embedded observations[] is its creation-time definition snapshot, NOT current state — each entity result carries a resolved `currentObservation` (newest non-superseded observation); read state from that or from get_current_observation, never from the embedded array (flagged embeddedObservationsAreDefinitionSnapshot when present).

Parameters

```json
{
  "type": "object",
  "properties": {
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Storage IDs to retrieve (max 5)",
      "maxItems": 5
    },
    "names": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Canonical entity names or aliases to resolve and retrieve (max 5)",
      "maxItems": 5
    },
    "entity": {
      "type": "string",
      "description": "Convenience alias for one canonical entity name or alias"
    },
    "maxTotalSize": {
      "type": "number",
      "description": "Hard maximum for the serialized response text in characters. Oversized entities are returned as truncated envelopes when possible. Minimum 256.",
      "default": 80000,
      "minimum": 256
    }
  },
  "anyOf": [
    {
      "required": [
        "ids"
      ]
    },
    {
      "required": [
        "names"
      ]
    },
    {
      "required": [
        "entity"
      ]
    }
  ]
}
```

### mark_messages_read
Mark specific messages or all unread messages for an agent as read

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Agent whose messages to mark as read"
    },
    "messageIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Specific message IDs to mark as read. If omitted, marks all unread messages for the agent."
    }
  },
  "required": [
    "agentId"
  ]
}
```

### archive_messages
Archive messages for an agent — either specific messageIds, or all messages older than N days. Set markAsRead:true to acknowledge and archive the same scoped messages atomically. Archived messages are excluded from get_ai_messages by default.

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Agent whose messages to archive"
    },
    "messageIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Specific message IDs to archive. If provided, olderThanDays is ignored."
    },
    "olderThanDays": {
      "type": "number",
      "description": "Archive messages older than this many days (used when messageIds is omitted)",
      "default": 30
    },
    "markAsRead": {
      "type": "boolean",
      "description": "Mark the same scoped messages as read in the archive transaction",
      "default": false
    }
  },
  "required": [
    "agentId"
  ]
}
```

### delete_entity
Delete an entity and cascade-delete its observations and relations from the knowledge graph. Requires admin-equivalent authorization.

Parameters

```json
{
  "type": "object",
  "properties": {
    "entityName": {
      "type": "string",
      "description": "Name of the entity to delete (case-insensitive match)"
    },
    "dryRun": {
      "type": "boolean",
      "description": "If true, return targets without executing deletion",
      "default": false
    },
    "reason": {
      "type": "string",
      "description": "Reason for deletion (recorded in audit log)"
    }
  },
  "required": [
    "entityName"
  ]
}
```

### remove_observations
Remove specific observations from an entity by ID or content match. Requires admin-equivalent authorization.

Parameters

```json
{
  "type": "object",
  "properties": {
    "entityName": {
      "type": "string",
      "description": "Entity the observations belong to (case-insensitive match)"
    },
    "observationIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Specific observation row IDs to remove"
    },
    "containsAny": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Remove observations whose content contains any of these substrings (case-insensitive, special chars escaped)"
    },
    "dryRun": {
      "type": "boolean",
      "description": "If true, return targets without executing deletion",
      "default": false
    },
    "reason": {
      "type": "string",
      "description": "Reason for removal (recorded in audit log)"
    }
  },
  "required": [
    "entityName"
  ]
}
```

### update_observation
Update the content of a specific observation. Runs sanitizer for parity with create/add paths. Requires admin-equivalent authorization.

Parameters

```json
{
  "type": "object",
  "properties": {
    "observationId": {
      "type": "string",
      "description": "Row ID of the observation to update"
    },
    "contentIndex": {
      "type": "number",
      "description": "Index within the contents array to replace (default: replaces entire content)"
    },
    "newContent": {
      "type": "string",
      "description": "New content string"
    },
    "reason": {
      "type": "string",
      "description": "Reason for update (recorded in audit log)"
    }
  },
  "required": [
    "observationId",
    "newContent"
  ]
}
```

### delete_observations_by_entity
Delete ALL observations for a given entity. Requires admin-equivalent authorization.

Parameters

```json
{
  "type": "object",
  "properties": {
    "entityName": {
      "type": "string",
      "description": "Entity name whose observations to delete (case-insensitive match)"
    },
    "dryRun": {
      "type": "boolean",
      "description": "If true, return targets without executing deletion",
      "default": false
    },
    "reason": {
      "type": "string",
      "description": "Reason for deletion (recorded in audit log)"
    }
  },
  "required": [
    "entityName"
  ]
}
```

### record_learning
Record a learning entry into an agent's individual memory

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Target agent ID (defaults to caller)"
    },
    "context": {
      "type": "string",
      "description": "Context where the learning occurred"
    },
    "lesson": {
      "type": "string",
      "description": "What was learned"
    },
    "confidence": {
      "type": "number",
      "description": "Confidence level 0-1",
      "default": 0.8
    }
  },
  "required": [
    "context",
    "lesson"
  ]
}
```

### set_preferences
Update agent preferences in individual memory

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Target agent ID (defaults to caller)"
    },
    "preferences": {
      "type": "object",
      "description": "Partial preferences object to merge"
    }
  },
  "required": [
    "preferences"
  ]
}
```

### get_individual_memory
Retrieve an agent's individual memory snapshot

Parameters

```json
{
  "type": "object",
  "properties": {
    "agentId": {
      "type": "string",
      "description": "Agent ID (defaults to caller)"
    }
  }
}
```

