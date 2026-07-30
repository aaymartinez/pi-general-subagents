// ─── Subagent Runtime Settings ─────────────────────────────────────
// Loads per-agent timeouts, thinking levels, and pipeline limits
// from .pi/subagents.json. Mirrors the models.json pattern.
//
// File structure:
//   {
//     "agents": {
//       "pm": { "timeout": 600, "thinking": "medium" },
//       ...
//     },
//     "pipeline": {
//       "maxParallel": 8,
//       "maxConcurrency": 4,
//       "collapsedItems": 10
//     },
//     "defaults": {
//       "timeout": 600,
//       "thinking": "medium"
//     }
//   }

import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentRuntimeConfig {
  timeout?: number;
  thinking?: string;
}

export interface PipelineConfig {
  maxParallel?: number;
  maxConcurrency?: number;
  collapsedItems?: number;
}

export interface DefaultConfig {
  timeout?: number;
  thinking?: string;
}

export interface SubagentsSettings {
  agents: Record<string, AgentRuntimeConfig>;
  pipeline: PipelineConfig;
  defaults: DefaultConfig;
  /**
   * Override: directory where agent .md files live.
   * If set, discoverAgents() loads from this path instead of .pi/agents/.
   * Useful for skills that package agents inside their own directory tree.
   */
  agentsDir?: string;
}

const DEFAULTS: SubagentsSettings = {
  agents: {
    default: { timeout: 600, thinking: "medium" },
  },
  pipeline: {
    maxParallel: 8,
    maxConcurrency: 4,
    collapsedItems: 10,
  },
  defaults: {
    timeout: 600,
    thinking: "medium",
  },
};

let settingsCache: SubagentsSettings | null = null;

/**
 * Load settings from .pi/subagents.json relative to the agents directory.
 * Falls back to hardcoded defaults if file doesn't exist or is invalid.
 */
export function loadSubagentsSettings(agentsDir: string | null): SubagentsSettings {
  if (settingsCache) return settingsCache;

  if (!agentsDir) {
    settingsCache = DEFAULTS;
    return DEFAULTS;
  }

  const settingsPath = path.join(path.dirname(agentsDir), "subagents.json");
  if (!fs.existsSync(settingsPath)) {
    settingsCache = DEFAULTS;
    return DEFAULTS;
  }

  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed: Partial<SubagentsSettings> = JSON.parse(raw);

    // Deep merge with defaults
    settingsCache = {
      agents: {
        ...DEFAULTS.agents,
        ...parsed.agents,
      },
      pipeline: {
        ...DEFAULTS.pipeline,
        ...parsed.pipeline,
      },
      defaults: {
        ...DEFAULTS.defaults,
        ...parsed.defaults,
      },
      agentsDir: parsed.agentsDir,
    };

    return settingsCache;
  } catch (err) {
    console.warn(`[general-subagents] Failed to load subagents settings from "${settingsPath}", using defaults. Error: ${(err as Error).message}`);
    settingsCache = DEFAULTS;
    return DEFAULTS;
  }
}

/**
 * Resolve per-agent timeout. Priority:
 * 1. Per-agent setting in subagents.json
 * 2. Default timeout from subagents.json
 * 3. Hardcoded default (600s)
 */
export function resolveTimeout(agentName: string, settings: SubagentsSettings, requestedTimeout?: number): number {
  if (requestedTimeout !== undefined) return requestedTimeout;
  const agentConfig = settings.agents[agentName];
  if (agentConfig?.timeout !== undefined) return agentConfig.timeout;
  return settings.defaults.timeout ?? 600;
}

/**
 * Resolve per-agent thinking level. Priority:
 * 1. Per-agent setting in subagents.json
 * 2. Default thinking from subagents.json
 * 3. Hardcoded default ("medium")
 */
export function resolveThinking(agentName: string, settings: SubagentsSettings, requestedThinking?: string): string {
  if (requestedThinking !== undefined) return requestedThinking;
  const agentConfig = settings.agents[agentName];
  if (agentConfig?.thinking !== undefined) return agentConfig.thinking;
  return settings.defaults.thinking ?? "medium";
}

/**
 * Get pipeline concurrency limit from settings.
 */
export function getMaxConcurrency(settings: SubagentsSettings): number {
  return settings.pipeline.maxConcurrency ?? DEFAULTS.pipeline.maxConcurrency!;
}

/**
 * Get max parallel tasks from settings.
 */
export function getMaxParallel(settings: SubagentsSettings): number {
  return settings.pipeline.maxParallel ?? DEFAULTS.pipeline.maxParallel!;
}

/**
 * Get collapsed items threshold from settings.
 */
export function getCollapsedItems(settings: SubagentsSettings): number {
  return settings.pipeline.collapsedItems ?? DEFAULTS.pipeline.collapsedItems!;
}

/**
 * Invalidate the settings cache (useful for hot-reload during development).
 */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}
