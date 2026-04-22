# Context and memory

Pi's minimal system prompt and explicit context model are its design bet: you get real levers for what the model sees. Use them deliberately. This file covers context injection, persistent memory, RAG, and project-level context files.

## The layers of context

From outermost to innermost per turn:

1. **System prompt** — pi's default, optionally replaced or appended by `SYSTEM.md`.
2. **AGENTS.md / CLAUDE.md** — project instructions loaded at startup.
3. **Skills** — capability packages loaded on-demand.
4. **Compaction summaries** — condensed older messages.
5. **Recent messages** — full fidelity, current turn.
6. **Per-turn injections** — RAG, memory recall, dynamic state.

An extension can modify layers 1, 5, and 6 directly. Layers 2–4 are controlled by files on disk but an extension can still read and react to them.

## AGENTS.md and SYSTEM.md

- **`AGENTS.md`** (or `CLAUDE.md`) — loaded from `~/.pi/agent/`, parent directories, and the current working directory. Concatenated. Good for project conventions, common commands, gotchas.
- **`SYSTEM.md`** — replaces or appends to pi's default system prompt. Per-project.

These are the simplest form of persistent context. Before reaching for extension-based memory, ask whether a markdown file would do.

## The `context` event — per-turn message rewriting

Fires before every LLM call. The handler gets `event.messages` and can mutate it. This is where RAG, memory recall, and dynamic context injection happen.

```ts
pi.on("context", async (event, ctx) => {
  // event.messages is the array going to the LLM
  // Mutate freely — mutations persist for this turn only
});
```

Tokens spent here are spent **every turn**. Budget accordingly:

- Fetch once, cache in extension scope.
- Inject only what's relevant to the *current* user message, not everything.
- Prefer short, structured inserts over prose dumps.

## Pattern: RAG

```ts
import { embed, search } from "./my-vector-store.js";

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    const lastUser = [...event.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const query = extractText(lastUser);
    const hits = await search(await embed(query), { k: 3 });
    if (hits.length === 0) return;

    event.messages.unshift({
      role: "system",
      content: [{
        type: "text",
        text: `Relevant project notes:\n${hits.map((h) => `- ${h.title}: ${h.snippet}`).join("\n")}`,
      }],
    });
  });
}
```

Details you'll typically want:

- **Top-k small**: 3–5 hits. More just bloats context.
- **Threshold**: skip injection if no hit clears a similarity bar.
- **Snippets, not documents**: retrieve the paragraph, not the 20-page PDF.

## Pattern: persistent memory via `pi.appendEntry`

`pi.appendEntry` stores data in the session's JSONL file. It survives restarts and is scoped to the session (not global). For cross-session state, use a file on disk.

```ts
// Write a memory entry at an interesting moment
pi.appendEntry({
  type: "extension:memory",
  extension: "my-memory",
  payload: { fact: "User prefers pytest over unittest" },
});

// Read memories back on session_start
pi.on("session_start", async (event, ctx) => {
  const entries = await pi.readEntries({ type: "extension:memory" });
  // inject on future turns, use to set behavior, etc.
});
```

For persistent *cross-session* memory (facts about the user, long-term project state), write to a file — pi doesn't impose a schema, but convention is `~/.pi/agent/memory/<your-extension>.json`.

## Pattern: long-term memory with consolidation

A practical memory system isn't "write everything to JSON and dump it back." It has three layers:

1. **Working memory** — the current conversation. Just the messages.
2. **Episodic memory** — extracted facts from recent sessions, stored with timestamps.
3. **Semantic memory** — consolidated facts, user preferences, project state. Compact, high-value.

Implementation sketch:

- On `session_shutdown`, spawn a sub-agent to review the session and extract any new facts worth remembering. Append to `memory/episodic.jsonl`.
- On `session_start`, load `memory/semantic.json` and inject a terse summary.
- Periodically (weekly, or on a command), run a consolidation pass: sub-agent reads episodic, extracts stable facts, updates semantic, archives the rest.

This avoids the failure mode where memory bloats until it's useless.

## Pattern: project state injection

Sometimes you want the LLM to always know some dynamic state — current git branch, failing tests, open PR count.

```ts
pi.on("context", async (event, ctx) => {
  const state = await getProjectState(); // fast, cached
  event.messages.unshift({
    role: "system",
    content: [{
      type: "text",
      text: `Current state: branch=${state.branch}, failing=${state.failing}, open_prs=${state.openPrs}`,
    }],
  });
});
```

Keep the check fast (cache it, refresh async) — this runs every turn. If it takes longer than ~200ms you'll feel it.

## Pattern: per-turn system prompt modification

For behavior that only applies to the next turn:

```ts
pi.on("before_agent_start", (event, ctx) => {
  // Append to the system prompt for this turn only
  event.systemPrompt += "\n\nNote: the user is in a hurry. Be concise.";
});
```

Good for mode switches (`/concise` command flips a flag; `before_agent_start` reads it).

## Top failure modes

1. **Unbounded memory growth.** Without consolidation, episodic memory becomes a liability. Cap it (N most recent + semantic summary).
2. **Leaking secrets through memory.** If the user pastes an API key and you snapshot it into memory, it leaks across sessions. Redact before writing.
3. **Expensive per-turn context fetches.** A synchronous network call in `context` stalls every turn. Cache, or use `agent_step` for async refresh.
4. **Injection that contradicts itself.** If your RAG injects stale docs, the LLM will follow them. Mark injections with timestamps and instruct the LLM to prefer newer info.
5. **Stepping on the compaction summary.** If you inject at position 0 every turn but pi's compaction summary also sits at position 0, you end up fighting for the same slot. Inject *after* compaction entries, or as a separate system message after the summary.
