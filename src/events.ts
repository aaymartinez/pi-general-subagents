// ─── Event System ───────────────────────────────────────────────────
// Writes pipeline-events.json for state tracking and audit trail.
// Serializes all event writes to prevent race conditions in parallel/batch mode.

import * as fs from "node:fs";
import * as path from "node:path";

// Serialize all event writes to prevent race conditions in parallel/batch mode.
// Without this, concurrent appendEvent calls would read stale state and drop events.
let eventWriteQueue: Promise<void> = Promise.resolve();

function enqueueEventWrite(fn: () => void): void {
  eventWriteQueue = eventWriteQueue.then(() => {
    try { fn(); } catch { /* ignore individual write errors to keep queue alive */ }
  });
}

export interface PipelineEvent {
  time: string;
  agent: string;
  phase: string;
  type: string;
  text: string;
  detail?: string;
  sessionId?: string;
}

export interface AgentEvidence {
  toolCalls: number;
  fileWrites: number;
  fileEdits: number;
  bashCommands: number;
  outputTokens: number;
}

export interface PipelineState {
  concept: string;
  currentPhase: string;
  pipelineStatus: "idle" | "running" | "paused" | "complete" | "failed";
  activeAgent: string;
  agentStatus: Record<string, string>;
  sessions: Record<string, string>;
  evidence: Record<string, AgentEvidence>;  // Per-agent evidence tracking
  events: PipelineEvent[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCostUsd: number };
}

const defaultUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 };
const defaultEvidence: AgentEvidence = { toolCalls: 0, fileWrites: 0, fileEdits: 0, bashCommands: 0, outputTokens: 0 };

const DEFAULT_STATE: PipelineState = {
  concept: "",
  currentPhase: "idle",
  pipelineStatus: "idle",
  activeAgent: "",
  agentStatus: {},
  sessions: {},
  evidence: {},
  events: [],
  usage: defaultUsage,
};

export function getEventsFile(projectDir: string): string {
  return path.join(projectDir, "pipeline-events.json");
}

export function loadEvents(eventsFile: string): PipelineState | null {
  if (!fs.existsSync(eventsFile)) return null;
  try {
    const existing = JSON.parse(fs.readFileSync(eventsFile, "utf-8"));
    return {
      concept: existing.concept || "",
      currentPhase: existing.currentPhase || "idle",
      pipelineStatus: existing.pipelineStatus || "idle",
      activeAgent: existing.activeAgent || "",
      agentStatus: existing.agentStatus || {},
      sessions: existing.sessions || {},
      evidence: existing.evidence || {},
      events: existing.events || [],
      usage: existing.usage || defaultUsage,
    };
  } catch {
    return null;
  }
}

export function saveEvents(eventsFile: string, state: PipelineState): void {
  fs.writeFileSync(eventsFile, JSON.stringify(state, null, 2));
}

export function appendEvent(eventsFile: string, event: PipelineEvent): void {
  enqueueEventWrite(() => {
    let state: PipelineState;
    if (fs.existsSync(eventsFile)) {
      const existing = loadEvents(eventsFile);
      state = existing || { ...DEFAULT_STATE };
    } else {
      state = { ...DEFAULT_STATE };
    }
    state.events.push(event);
    saveEvents(eventsFile, state);
  });
}

export function initEvents(eventsFile: string, concept: string, phase: string): PipelineState {
  const state: PipelineState = {
    ...DEFAULT_STATE,
    concept,
    currentPhase: phase,
    pipelineStatus: "running",
    events: [
      {
        time: new Date().toISOString(),
        agent: "system",
        phase,
        type: "pipeline-start",
        text: `Pipeline started: ${concept}`,
      },
    ],
  };

  saveEvents(eventsFile, state);
  return state;
}

// ─── Evidence Helpers ───────────────────────────────────────────────

export function updateAgentEvidence(eventsFile: string, agentName: string, evidence: any): void {
  enqueueEventWrite(() => {
    const state = loadEvents(eventsFile) || { ...DEFAULT_STATE };
    if (!state.evidence) state.evidence = {};
    state.evidence[agentName] = {
      toolCalls: (state.evidence[agentName]?.toolCalls || 0) + (evidence.toolCalls || 0),
      fileWrites: (state.evidence[agentName]?.fileWrites || 0) + (evidence.fileWrites || 0),
      fileEdits: (state.evidence[agentName]?.fileEdits || 0) + (evidence.fileEdits || 0),
      bashCommands: (state.evidence[agentName]?.bashCommands || 0) + (evidence.bashCommands || 0),
      outputTokens: (state.evidence[agentName]?.outputTokens || 0) + (evidence.outputTokens || 0),
    };
    saveEvents(eventsFile, state);
  });
}
