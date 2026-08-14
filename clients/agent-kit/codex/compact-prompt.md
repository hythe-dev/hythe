# Compaction prompt addition (HYTHE) — Codex
# Referenced by experimental_compact_prompt_file in ~/.codex/config.toml.
# Whatever else the compacted summary contains, it MUST end with this block:

MANDATORY POST-COMPACTION MEMORY STEPS — perform before continuing any task:
0. Confirm the exact pre-compaction agentId is present in trusted,
   model-visible session context. MCP child-process env is not model-visible.
   If it is absent, FAIL CLOSED: do not call any HYTHE identity-scoped tool,
   and restart through the same identity-bound launcher/hook. Never guess.
1. Call the hythe `checkpoint` tool with the content of this compacted
   summary using that exact bound agentId. This persists pre-compaction work.
2. Call `resume` with the same agentId to recover session history and
   current observations.
3. Call `get_ai_messages` — a message may have arrived during compaction.
4. Only then continue the user's task. Skipping these steps means the work
   summarized above exists nowhere durable and context is lost.
