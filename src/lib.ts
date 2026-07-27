// Barrel exports for general-subagents module

export { createSessionHash } from "./session";
export { getEventsFile, appendEvent, initEvents, loadEvents, saveEvents, updateAgentEvidence, type PipelineEvent, type PipelineState, type AgentEvidence } from "./events";
export { loadAgentsFromDir, discoverAgents } from "./agents";
export { runSingleAgent, mapWithConcurrencyLimit, formatTokens, formatUsage, getFinalOutput, getDisplayItems, resolveTimeout, resolveThinking, isResultError } from "./runner";
export { renderCall, renderResult } from "./render";
export { extractEvidence, type Evidence } from "./evidence";
export { MAX_PARALLEL, MAX_CONCURRENCY, COLLAPSED_ITEMS, AGENT_TIMEOUTS, AGENT_THINKING, DEFAULT_THINKING, DEFAULT_TIMEOUT, type AgentConfig, type AgentScope, type UsageStats, type SingleResult, type SubagentDetails, type DisplayItem, type OnUpdateCallback, type Evidence as ResultEvidence } from "./types";
export { TaskItem, ChainItem, AgentScopeSchema, BatchStageItem, BatchParams, SubagentParams, ListAgentsParams } from "./types";

// ─── Runtime Settings ─────────────────────────────────────────────
export {
  loadSubagentsSettings,
  resolveTimeout as resolveTimeoutFromSettings,
  resolveThinking as resolveThinkingFromSettings,
  getMaxConcurrency,
  getMaxParallel,
  getCollapsedItems,
  invalidateSettingsCache,
  type AgentRuntimeConfig,
  type PipelineConfig,
  type DefaultConfig,
  type SubagentsSettings,
} from "./subagents-settings";
