// ─── Subagent Runner ────────────────────────────────────────────────
// Spawns isolated Pi.dev subprocesses for each subagent invocation.
// Each subagent gets its own context window, persona, skills, and tools.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { type Message } from "@earendil-works/pi-ai";
import type {
  AgentConfig,
  SingleResult,
  SubagentDetails,
  UsageStats,
  OnUpdateCallback,
} from "./types";
import { createSessionHash } from "./session";
import { appendEvent, initEvents, getEventsFile, loadEvents, saveEvents, updateAgentEvidence } from "./events";
import { extractEvidence } from "./evidence";
import {
  type SubagentsSettings,
  loadSubagentsSettings,
  resolveTimeout as resolveTimeoutFromSettings,
  resolveThinking as resolveThinkingFromSettings,
} from "./subagents-settings";
import { DEFAULT_THINKING, DEFAULT_TIMEOUT } from "./types";

export function resolveTimeout(agentName: string, settings: SubagentsSettings, requestedTimeout?: number): number {
  return resolveTimeoutFromSettings(agentName, settings, requestedTimeout);
}

export function resolveThinking(agentName: string, settings: SubagentsSettings, requestedThinking?: string): string {
  return resolveThinkingFromSettings(agentName, settings, requestedThinking);
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getDisplayItems(messages: Message[]): import("./types").DisplayItem[] {
  const items: import("./types").DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isResultError(r: SingleResult): boolean {
  return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.stopReason === "timeout";
}

export function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number, signal: AbortSignal | undefined) => Promise<TOut>,
  abortSignal?: AbortSignal,
): Promise<TOut[]> {
  if (items.length === 0) return Promise.resolve([]);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < limit; w++) {
    workers.push((async () => {
      while (true) {
        if (abortSignal?.aborted) return;
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await fn(items[current], current, abortSignal);
      }
    })());
  }
  return Promise.all(workers) as Promise<TOut[]>;
}

async function writePromptToTempFile(content: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "subagent-"));
  const filePath = path.join(tmpDir, "system-prompt.md");
  await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function resolvePiCliPath(): string | null {
  // Try 1: process.argv[1] — the currently running script path
  const argv1 = process.argv[1];
  if (argv1 && !argv1.startsWith("/$bunfs/root/") && fs.existsSync(argv1)) {
    return argv1;
  }

  // Try 2: Resolve the pi CLI from the npm bin directory.
  const npmBin = __dirname;
  let dir = npmBin;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Try 3: Look in the same npm bin as the current process.
  const piBin = process.env.PATH
    ? path.join(path.dirname(process.env.PATH!.split(path.delimiter)[0]), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
    : null;
  if (piBin && fs.existsSync(piBin)) return piBin;

  return null;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const cliPath = resolvePiCliPath();
  if (cliPath) {
    return { command: process.execPath, args: [cliPath, ...args] };
  }

  // Ultimate fallback — spawn through cmd (Windows) or pi (Unix).
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "pi.cmd", ...args] };
  }
  return { command: "pi", args };
}

export async function runSingleAgent(
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string,
  eventsFile: string,
  phase: string,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  settings: SubagentsSettings,
  timeoutSeconds?: number,
  outputFormat?: string,
  thinkingLevel?: string,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ");
    return {
      agent: agentName, agentSource: "unknown", task, exitCode: 1,
      messages: [], stderr: `Unknown agent: "${agentName}". Available: ${available}`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  const sessionHash = createSessionHash(agentName, task);

  const effectiveTask = outputFormat
    ? `${task}\n\n---\nReturn your response in ${outputFormat} format.`
    : task;

  const args: string[] = ["--mode", "json", "-p", `Task: ${effectiveTask}`, "--no-session"];

  if (agent.model) args.unshift("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  const resolvedThinking = resolveThinking(agentName, settings, thinkingLevel);
  if (resolvedThinking !== "off") args.push("--thinking", resolvedThinking);

  const resolvedTimeout = resolveTimeout(agentName, settings, timeoutSeconds);

  const currentResult: SingleResult = {
    agent: agentName, agentSource: agent.source, task, exitCode: 0,
    messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model, step, sessionId: sessionHash,
  };

  let sessionFile: string | null = null;
  let tmpDir: string | null = null;
  let tmpPath: string | null = null;

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.systemPrompt);
      tmpDir = tmp.dir;
      tmpPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPath);
    }
    let wasAborted = false;
    let wasTimedOut = false;

    // Write sentinel file before spawning so the block guard in index.ts can detect
    // subagent context via filesystem even when env vars don't propagate (Windows cmd wrapper).
    const sentinelPath = path.join(cwd, ".subagent-running");
    try { fs.writeFileSync(sentinelPath, agentName, "utf-8"); } catch { /* ignore */ }

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SUBAGENT_IS_RUNNING: "1", SUBAGENT_NAME: agentName },
      });
      let buffer = "";

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
        const match = data.toString().match(/Session file:\s*(\S+\.jsonl)/);
        if (match && !sessionFile) {
          sessionFile = match[1];
        }
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);
          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const u = msg.usage;
            if (u) {
              currentResult.usage.input += u.input || 0;
              currentResult.usage.output += u.output || 0;
              currentResult.usage.cacheRead += u.cacheRead || 0;
              currentResult.usage.cacheWrite += u.cacheWrite || 0;
              currentResult.usage.cost += u.cost?.total || 0;
              currentResult.usage.contextTokens = u.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }
        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (buffer.trim()) processLine(buffer);
        try { fs.unlinkSync(sentinelPath); } catch { /* ignore */ }
        resolve(code ?? 0);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        try { fs.unlinkSync(sentinelPath); } catch { /* ignore */ }
        currentResult.errorMessage = `Failed to spawn pi: ${err.message}`;
        resolve(1);
      });

      const timer = setTimeout(() => {
        wasTimedOut = true;
        proc.kill("SIGTERM");
        currentResult.stopReason = "timeout";
        currentResult.errorMessage = `Agent timed out after ${resolvedTimeout}s (${Math.floor(resolvedTimeout / 60)} min)`;
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      }, resolvedTimeout * 1000);

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          clearTimeout(timer);
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) { clearTimeout(timer); killProc(); }
        else signal.addEventListener("abort", () => { clearTimeout(timer); killProc(); }, { once: true });
      }
    });

    currentResult.exitCode = exitCode;

    const resolvedSessionFile = sessionFile as string | null;
    if (resolvedSessionFile) {
      const existing = loadEvents(eventsFile);
      const state: import("./events").PipelineState = existing ?? {
        concept: "", currentPhase: "idle", pipelineStatus: "idle", activeAgent: "",
        agentStatus: {}, sessions: {}, evidence: {}, events: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
      };
      const uuidMatch = resolvedSessionFile.match(/_(\w{8}-\w{4}-\w{4}-\w{4}-\w{12})\.jsonl$/);
      const sessionId = uuidMatch ? uuidMatch[1] : sessionHash;
      state.sessions[agentName] = sessionId;
      saveEvents(eventsFile, state);
    }

    // ─── Evidence Extraction ────────────────────────────────────
    const evidence = extractEvidence(currentResult);

    // Store evidence in pipeline state
    updateAgentEvidence(eventsFile, agentName, {
      toolCalls: evidence.filter((e) => e.type === "tool_call").reduce((s, e) => s + e.count, 0),
      fileWrites: evidence.filter((e) => e.type === "file_write").reduce((s, e) => s + e.count, 0),
      fileEdits: evidence.filter((e) => e.type === "file_edit").reduce((s, e) => s + e.count, 0),
      bashCommands: evidence.filter((e) => e.type === "bash_command").reduce((s, e) => s + e.count, 0),
      outputTokens: evidence.filter((e) => e.type === "model_output").reduce((s, e) => s + e.count, 0),
    });

    // Attach evidence to result for caller awareness
    currentResult.evidence = evidence;

    const statusText = currentResult.exitCode === 0 ? "completed" : `failed (${currentResult.stopReason || currentResult.exitCode})`;
    appendEvent(eventsFile, {
      time: new Date().toISOString(),
      agent: agentName,
      phase,
      type: step !== undefined ? `step-${step}-complete` : "task-complete",
      text: `${agentName}: ${statusText}`,
      detail: currentResult.stderr || currentResult.errorMessage || "",
      sessionId: sessionFile ? sessionHash : undefined,
    });

    if (wasAborted) throw new Error("Subagent was aborted");
    if (wasTimedOut) {
      currentResult.stderr += `\n[TIMEOUT] Agent exceeded ${resolvedTimeout}s limit`;
      return currentResult;
    }
    return currentResult;
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
