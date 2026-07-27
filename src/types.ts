// ─── Types & Schemas ────────────────────────────────────────────────
// General Subagents Extension — mechanism-only types
// No Phase 2 (context curation, result compression, model routing, memory bridge)
// No Phase 3 (policy engine, pipeline metrics)

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export type AgentScope = "user" | "project" | "both";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: import("@earendil-works/pi-ai").Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  sessionId?: string;
  // Evidence: observable work done by the agent (tool calls, file writes, etc.)
  evidence?: Evidence[];
}

export interface Evidence {
  type: "tool_call" | "file_write" | "file_edit" | "bash_command" | "model_output";
  count: number;
  details?: string[];
}

export interface SubagentDetails {
  mode: "single" | "chain" | "parallel" | "batch";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  sessions: Record<string, string>;
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (
  partial: { content: Array<{ type: string; text?: string }>; details?: SubagentDetails }
) => void;

// ─── Constants (defaults — overridden by .pi/subagents.json) ────────
// Per-agent settings are loaded from .pi/subagents.json at runtime.
// See src/subagents-settings.ts for the loader.
//
// These defaults are used when subagents.json doesn't exist.
// To customize, create .pi/subagents.json with your preferred values.

/** @deprecated Use `getMaxParallel(settings)` from subagents-settings.ts */
export const MAX_PARALLEL = 8;
/** @deprecated Use `getMaxConcurrency(settings)` from subagents-settings.ts */
export const MAX_CONCURRENCY = 4;
/** @deprecated Use `getCollapsedItems(settings)` from subagents-settings.ts */
export const COLLAPSED_ITEMS = 10;

/** @deprecated Use `resolveTimeout(agentName, settings)` from subagents-settings.ts */
export const AGENT_TIMEOUTS: Record<string, number> = {
  default: 600,
};

/** @deprecated Use `resolveThinking(agentName, settings)` from subagents-settings.ts */
export const AGENT_THINKING: Record<string, string> = {
  default: "medium",
};

/** @deprecated Use `settings.defaults.thinking` from subagents-settings.ts */
export const DEFAULT_THINKING = "medium";
/** @deprecated Use `settings.defaults.timeout` from subagents-settings.ts */
export const DEFAULT_TIMEOUT = 600;

// ─── TypeBox Schemas ────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (overrides context cwd)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for this specific task (default: per-agent timeout)" })),
  outputFormat: Type.Optional(Type.String({ description: "Requested output format: 'markdown', 'json', or leave empty for agent default" })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking level: 'off', 'minimal', 'low', 'medium', 'high', 'xhigh' (default: per-agent)" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (overrides context cwd)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for this specific step (default: per-agent timeout)" })),
  outputFormat: Type.Optional(Type.String({ description: "Requested output format: 'markdown', 'json', or leave empty for agent default" })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking level: 'off', 'minimal', 'low', 'medium', 'high', 'xhigh' (default: per-agent)" })),
});

const AgentScopeSchema = StringEnum(["project", "user", "both"] as const, {
  description: 'Which agent directories to use. Default: "project" (project-local agents). Use "user" for global agents, "both" for all.',
  default: "project",
});

const BatchStageItem = Type.Object({
  name: Type.String({ description: "Stage name for tracking (e.g., 'planning', 'building')" }),
  tasks: Type.Array(TaskItem, { description: "Tasks to run in this stage (can be parallel)" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for this entire stage" })),
  outputFormat: Type.Optional(Type.String({ description: "Requested output format for all tasks in this stage" })),
});

const BatchParams = Type.Object({
  stages: Type.Array(BatchStageItem, {
    description: [
      "Run the pipeline in staged batches. Results are available after each stage",
      "for review. Example: [{ name: 'planning', tasks: [{ agent: 'pm', task: '...' }]",
      "        { name: 'building', tasks: [{ agent: 'coder', task: '...' }] }]",
    ].join(" "),
  }),
  agentScope: Type.Optional(AgentScopeSchema),
  timeout: Type.Optional(Type.Number({ description: "Default timeout for all stages (overrides per-stage timeout)" })),
  outputFormat: Type.Optional(Type.String({ description: "Default output format for all stages" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for all stages" })),
});

const SubagentParams = Type.Object({
  mode: Type.String({ description: "Required. One of: single, chain, parallel, batch" }),
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (required for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (required for single mode)" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential steps with {previous} placeholder" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks to execute simultaneously" })),
  stages: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ description: "Stage name for tracking" }),
    tasks: Type.Array(TaskItem, { description: "Tasks to run in this stage (can be parallel)" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for this stage" })),
    outputFormat: Type.Optional(Type.String({ description: "Requested output format" })),
  }))),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  timeout: Type.Optional(Type.Number({ description: "Default timeout in seconds" })),
  outputFormat: Type.Optional(Type.String({ description: "Requested output format" })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking level" })),
}, { description: "Specify mode (single/chain/parallel/batch) and corresponding fields. For single mode: mode='single', agent='pm', task='...'" });

const ListAgentsParams = Type.Object({
  agentScope: Type.Optional(AgentScopeSchema),
});

export { TaskItem, ChainItem, AgentScopeSchema, BatchStageItem, BatchParams, SubagentParams, ListAgentsParams };
