# Compaction prompt addition (HYTHE) — Codex
# Referenced by experimental_compact_prompt_file in ~/.codex/config.toml.
# Whatever else the compacted summary contains, it MUST end with this block:

MANDATORY POST-COMPACTION MEMORY STEPS — perform before continuing any task:
0. Confirm the exact pre-compaction agentId is present in trusted,
   model-visible session context. MCP child-process env is not model-visible.
   If it is absent, FAIL CLOSED: do not call any HYTHE identity-scoped tool,
   and restart through the same identity-bound launcher/hook. Never guess.
1. Call `resume` (read-only) with that exact bound agentId, the scope you
   used before compaction (or {"project": "<working-directory name>"}), and
   a budget, then note asOf.revision in the result:
   resume {"agentId":"<agentId>","scope":{"project":"<project>"},"budget":4000}
2. Call the hythe `checkpoint` tool to persist this compacted summary:
   checkpoint {"agentId":"<agentId>","scope":{"project":"<project>"},"expectedRevision":null,"idempotencyKey":"<agentId>-compact-<UTC timestamp>","state":{"objective":"<goal>","status":"<done and in progress>","owner":"<agentId>","nextActions":["<next step>"],"blockers":[],"guardrails":[]}}
   Replace expectedRevision null with asOf.revision from step 1 (keep null
   only if that was null). All six state fields are required. Retry a failed
   call with the same idempotencyKey and arguments; it will not write twice.
3. Call `get_ai_messages` — a message may have arrived during compaction.
4. Only then continue the user's task. Skipping these steps means the work
   summarized above exists nowhere durable and context is lost.
