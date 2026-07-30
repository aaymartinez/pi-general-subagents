# General Subagents Extension

**Generic subprocess spawning for Pi.dev** — reusable by any project or skill.

---

## Overview

This extension provides a **mechanism** for spawning isolated Pi.dev subprocesses (subagents) with support for single, chain, parallel, and batch execution modes. It is **orchestration-agnostic** — any project or orchestrator can use it to delegate work to specialized agents.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Orchestration Layer (any orchestrator)       │
│  ┌───────────┬──────────┬───────────┐       │
│  │ retry-    │ context  │ policy    │       │
│  │ circuit   │ budget   │ engine    │       │
│  └─────┬─────┴────┬─────┴─────┬─────┘       │
│        │          │           │             │
│        └──────────┴─────┬─────┘             │
│                        │ calls               │
├────────────────────────┼─────────────────────┤
│  General Subagents Extension                  │
│  ┌──────────────────────────────────────┐    │
│  │  pi.registerTool("subagent")         │    │
│  │  pi.registerTool("list_agents")      │    │
│  └──────────────┬───────────────────────┘    │
│                 │ spawns                      │
├─────────────────┼─────────────────────────────┤
│  Subprocess (isolated Pi.dev instance)        │
│  ┌──────────┬──────────┬──────────────┐      │
│  │ session  │ system   │ tools +      │      │
│  │ hash     │ prompt   │ skills       │      │
│  └──────────┴──────────┴──────────────┘      │
└─────────────────────────────────────────────┘
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Single mode** | One agent, one task |
| **Chain mode** | Sequential steps with `{previous}` placeholder for prior output |
| **Parallel mode** | Multiple tasks simultaneously (concurrency-limited) |
| **Batch mode** | Staged pipeline — results after each stage for review |
| **Session persistence** | Deterministic session hashing enables resume from last state |
| **Hard block** | Subagents cannot spawn subagents (env var + sentinel file) |
| **Event system** | `pipeline-events.json` for audit trail and state tracking |
| **Agent discovery** | Scans `.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user). Override with `agentsDir` in `.pi/subagents.json` to use relative or absolute paths like `"skills/rei/agents"` or `"../skills/rei/agents"` |
| **Tiered timeouts** | Per-agent timeout, thinking level, and concurrency from settings |
| **Evidence extraction** | Counts tool calls, file writes, bash commands from agent output |

---

## Tools

### `subagent`

Delegate tasks to specialized agents with isolated context windows.

**Parameters:**

| Field | Mode(s) | Required | Description |
|-------|---------|----------|-------------|
| `mode` | all | yes | `single`, `chain`, `parallel`, or `batch` |
| `agent` | single | conditional | Agent name (required for single mode) |
| `task` | single | conditional | Task description (required for single mode) |
| `chain` | chain | conditional | Array of `{ agent, task, cwd?, timeout?, outputFormat?, thinkingLevel? }` |
| `tasks` | parallel | conditional | Array of `{ agent, task, cwd?, timeout?, outputFormat?, thinkingLevel? }` |
| `stages` | batch | conditional | Array of `{ name, tasks: [...], timeout?, outputFormat? }` |
| `agentScope` | all | no | `"project"`, `"user"`, or `"both"` (default: `"project"`) |
| `cwd` | all | no | Working directory for spawned processes |
| `timeout` | all | no | Default timeout in seconds (overridden by per-agent/task) |
| `outputFormat` | all | no | `"markdown"`, `"json"`, or empty for agent default |
| `thinkingLevel` | all | no | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |

**Returns:**

```typescript
{
  content: [{ type: "text", text: summary }],
  details: {
    mode: "single" | "chain" | "parallel" | "batch",
    agentScope: "project" | "user" | "both",
    projectAgentsDir: string | null,
    results: SingleResult[],
    sessions: Record<string, string>
  }
}
```

### `list_agents`

List all available agents and their configurations.

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `agentScope` | no | `"project"`, `"user"`, or `"both"` (default: `"project"`) |

**Returns:**

```
Available agents (N):

  - Agent Name (agent_type) (project): Description [tool1, tool2, ...]
```

---

## Configuration

### Project Settings

Create `.pi/subagents.json` in your project to customize behavior:

```json
{
  "agents": {
    "pm": { "timeout": 600, "thinking": "medium" },
    "ba": { "timeout": 300, "thinking": "high" },
    "coder": { "timeout": 1800, "thinking": "medium" },
    "qa": { "timeout": 600, "thinking": "high" },
    "security": { "timeout": 600, "thinking": "high" }
  },
  "pipeline": {
    "maxParallel": 8,
    "maxConcurrency": 4,
    "collapsedItems": 10
  },
  "defaults": {
    "timeout": 600,
    "thinking": "medium"
  }
}
```

**Resolution priority:**

1. Per-task override (passed to `subagent` tool)
2. Per-agent setting in `subagents.json`
3. Default from `subagents.json`
4. Hardcoded default (600s timeout, "medium" thinking)

### Custom Agents Directory

Use `agentsDir` to point to a non-standard location for agent `.md` files. Relative paths are resolved against the project's `cwd`:

```json
{
  "agentsDir": "skills/rei/agents",
  "agents": {
    "pm": { "timeout": 600, "thinking": "medium" },
    "coder": { "timeout": 1800, "thinking": "medium" }
  }
}
```

**Path resolution:**

| Value | Resolves to |
|-------|-------------|
| `"skills/rei/agents"` | `<cwd>/skills/rei/agents` |
| `"../skills/rei/agents"` | `<parent>/skills/rei/agents` |
| `"/absolute/path/to/agents"` | `/absolute/path/to/agents` |
| `"../../other-skill/agents"` | `<grandparent>/other-skill/agents` |

When `agentsDir` is set, agent discovery uses it **instead of** the default `.pi/agents/` directory. This is useful for skills that package their agents inside their own directory tree.

**Default fallback:** If `agentsDir` is not set, the extension scans for `.pi/agents/` directories starting from `cwd` and walking up to the filesystem root.

### Model Assignment

Create `.pi/models.json` for model-to-agent routing:

```json
{
  "default": "llama-3.1-8b",
  "agents": {
    "pm": "llama-3.1-8b",
    "coder": "qwen-2.5-7b",
    "qa": "llama-3.1-8b"
  }
}
```

**Resolution priority:**

1. Per-agent override in `models.json`
2. Default from `models.json`
3. Frontmatter `model:` in agent `.md` file
4. Pi's default provider

### Project Registration (optional)

Add to `.pi/settings.json` to declare the extension:

```json
{
  "llamaServerUrl": "http://127.0.0.1:8338",
  "extensions": {
    "general-subagents": {
      "enabled": true,
      "settingsPath": ".pi/subagents.json"
    }
  }
}
```

---

## File Structure

```
general-subagents/
├── index.ts                 ← Extension entry point (tool registration)
├── tsconfig.json
├── README.md                ← This file
└── src/
    ├── agents.ts            ← Agent discovery (project + user scope)
    ├── runner.ts            ← Subprocess spawning, JSONL parsing
    ├── session.ts           ← Deterministic session hashing
    ├── events.ts            ← pipeline-events.json writer
    ├── render.ts            ← TUI rendering helpers
    ├── evidence.ts          ← Extract tool calls, file writes from results
    ├── types.ts             ← Shared types and TypeBox schemas
    ├── subagents-settings.ts ← Load .pi/subagents.json, resolve config
    └── lib.ts               ← Barrel exports
```

---

## What's NOT Included

This extension is **mechanism-only**. The following are handled by the orchestration layer:

- ❌ Context curation (which files to include per agent)
- ❌ Result compression (chain mode summaries)
- ❌ Model routing (model assignment logic)
- ❌ Memory bridge (brain search, lesson writing)
- ❌ Policy engine (quality gates, effectiveness checks)
- ❌ Pipeline metrics aggregation
- ❌ Brain context injection
- ❌ Doctrine file copying

---

## Usage Example

### Single Mode

```json
{
  "mode": "single",
  "agent": "pm",
  "task": "Write a product requirements doc for a task manager app"
}
```

### Chain Mode

```json
{
  "mode": "chain",
  "chain": [
    { "agent": "pm", "task": "Define the architecture" },
    { "agent": "ba", "task": "Create backlog from: {previous}" },
    { "agent": "coder", "task": "Implement from backlog: {previous}" }
  ]
}
```

### Parallel Mode

```json
{
  "mode": "parallel",
  "tasks": [
    { "agent": "pm", "task": "Write PRD" },
    { "agent": "qa", "task": "Write test plan" }
  ]
}
```

### Batch Mode

```json
{
  "mode": "batch",
  "stages": [
    {
      "name": "planning",
      "tasks": [
        { "agent": "pm", "task": "Write PRD" },
        { "agent": "ba", "task": "Write backlog" }
      ]
    },
    {
      "name": "building",
      "tasks": [
        { "agent": "coder", "task": "Implement features" }
      ]
    }
  ]
}
```

---

## Hard Block

Subagents **cannot** call `subagent` recursively. This is enforced via:

1. **Environment variable:** `SUBAGENT_IS_RUNNING=1` + `SUBAGENT_NAME` set on spawn
2. **Sentinel file:** `.subagent-running` created in cwd before spawn, deleted after

If triggered, the response is:

```
❌ BLOCKED: subagent cannot be called from within a subagent.
This is working as intended — NOT a configuration error.
You are the {agent_name} agent. Do NOT retry subagent.
```

---

## Session Management

Sessions are hashed deterministically from agent name + task:

```
agentName: "pm"
task: "Write a PRD for X"
→ hash: "pm-a3f2b1c4"
→ session file: "pm-a3f2b1c4.jsonl"
```

This enables **session resume** — if a subagent stalls, restarting it with the same task restores its prior state.

---

## License

Internal use — part of the Pi.dev ecosystem.
