// ─── Agent Discovery ────────────────────────────────────────────────
// Discovers agents from project-local and user-level agent directories.
// Agents are defined as .md files with frontmatter (name, description, tools, model).

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope } from "./types";

// ─── Model Settings ─────────────────────────────────────────────────

interface ModelSettings {
  default: string;
  agents: Record<string, string>;
}

let modelSettingsCache: ModelSettings | null = null;

function loadModelSettings(agentsDir: string): ModelSettings | null {
  if (modelSettingsCache) return modelSettingsCache;

  const settingsPath = path.join(path.dirname(agentsDir), "models.json");
  if (!fs.existsSync(settingsPath)) return null;

  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings: ModelSettings = JSON.parse(raw);
    modelSettingsCache = settings;
    return settings;
  } catch {
    console.warn(`[general-subagents] Failed to load model settings from "${settingsPath}", falling back to frontmatter.`);
    return null;
  }
}

function resolveModel(agentName: string, frontmatterModel?: string, agentsDir?: string): string | undefined {
  // Priority 1: per-agent override in settings file
  const settings = agentsDir ? loadModelSettings(agentsDir) : null;
  if (settings?.agents?.[agentName]) return settings.agents[agentName];

  // Priority 2: default from settings file
  if (settings?.default) return settings.default;

  // Priority 3: frontmatter model (backward compat)
  if (frontmatterModel) return frontmatterModel;

  // Priority 4: undefined — let pi use its default provider
  return undefined;
}

export function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[general-subagents] Failed to read agents directory "${dir}": ${err}`);
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ? (frontmatter.tools as string).split(",").map((t: string) => t.trim()).filter(Boolean)
      : undefined;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: resolveModel(frontmatter.name, frontmatter.model as string | undefined, source === "project" ? dir : undefined),
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope, customAgentsDir?: string | null) {
  // Custom agentsDir overrides the default .pi/agents/ discovery.
  // This lets skills (like REI) specify where their agents live.
  // Relative paths are resolved against cwd so you can use paths like "../skills/rei/agents".
  let projectAgentsDir: string | null = null;
  if (customAgentsDir) {
    projectAgentsDir = path.isAbsolute(customAgentsDir)
      ? customAgentsDir
      : path.resolve(cwd, customAgentsDir);
  } else {
    projectAgentsDir = findNearestProjectAgentsDir(cwd);
  }

  const userDir = path.join(getAgentDir(), "agents");
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();
  if (scope === "both") {
    for (const a of userAgents) agentMap.set(a.name, a);
    for (const a of projectAgents) agentMap.set(a.name, a);
  } else if (scope === "user") {
    for (const a of userAgents) agentMap.set(a.name, a);
  } else {
    for (const a of projectAgents) agentMap.set(a.name, a);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
