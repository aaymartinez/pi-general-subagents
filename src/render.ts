// ─── Render Helpers ─────────────────────────────────────────────────
// TUI rendering for subagent calls and results.
// Generic — no hardcoded agent names.

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { DisplayItem, SubagentDetails, UsageStats } from "./types";
import { formatUsage, getFinalOutput, getDisplayItems } from "./runner";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function sumUsage(results: { usage: UsageStats }[]): UsageStats {
  return results.reduce((acc, r) => ({
    input: acc.input + r.usage.input,
    output: acc.output + r.usage.output,
    cacheRead: acc.cacheRead + r.usage.cacheRead,
    cacheWrite: acc.cacheWrite + r.usage.cacheWrite,
    cost: acc.cost + r.usage.cost,
    contextTokens: acc.contextTokens + r.usage.contextTokens,
    turns: acc.turns + r.usage.turns,
  }), ZERO_USAGE);
}

function renderToolCallText(theme: any, item: DisplayItem): string {
  if (item.type !== "toolCall") return "";
  return `${theme.fg("muted", "→ ")}${item.name}(${JSON.stringify(item.args).slice(0, 50)})\n`;
}

function renderItems(items: DisplayItem[], limit?: number, expanded?: boolean, theme?: any): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += `${theme.fg("muted", `... ${skipped} earlier items\n`)}`;
  for (const item of toShow) {
    if (item.type === "text") {
      text += `${theme.fg("toolOutput", expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n"))}\n`;
    } else {
      text += renderToolCallText(theme, item);
    }
  }
  return text.trimEnd();
}

export function renderCall(args: Record<string, any>, theme: any): Text {
  if (args.chain && args.chain.length > 0) {
    let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`);
    for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
      const step = args.chain[i];
      const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
      const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("dim", preview)}`;
    }
    if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }

  if (args.tasks && args.tasks.length > 0) {
    let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
    for (const t of args.tasks.slice(0, 3)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
      text += `\n  ${theme.fg("accent", t.agent)} ${theme.fg("dim", preview)}`;
    }
    if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }

  const agentName = args.agent || "...";
  const displayName = agentName;
  const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
  return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", displayName)} ${theme.fg("dim", preview)}`, 0, 0);
}

// ─── Shared render helpers ──────────────────────────────────────────

function addResultToContainer(container: Container, r: { exitCode: number; agent: string; step?: number; task: string; messages: any[]; usage: UsageStats; model?: string }, theme: any): void {
  const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);
  container.addChild(new Spacer(1));
  container.addChild(new Text(`${theme.fg("muted", r.step !== undefined ? `─── Step ${r.step}: ${r.agent} ` : `─── ${r.agent} `)}${rIcon}`, 0, 0));
  container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

  for (const item of displayItems) {
    container.addChild(new Text(renderToolCallText(theme, item), 0, 0));
  }
  if (finalOutput) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(finalOutput.trim(), 0, 0));
  }
  const taskUsage = formatUsage(r.usage, r.model);
  if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
}

// ─── Result renderer ────────────────────────────────────────────────

export function renderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentDetails },
  { expanded }: { expanded: boolean },
  theme: any,
): Text | Container {
  const details = result.details;

  if (!details || details.results.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  // Single mode
  if (details.mode === "single" && details.results.length === 1) {
    const r = details.results[0];
    const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = getDisplayItems(r.messages);
    const finalOutput = getFinalOutput(r.messages);

    if (expanded) {
      const container = new Container();
      let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))} (${r.agentSource})`;
      if (isError && r.stopReason) header += ` [${r.stopReason}]`;
      container.addChild(new Text(header, 0, 0));
      if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
      container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
      if (displayItems.length === 0 && !finalOutput) container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
      else {
        for (const item of displayItems) {
          container.addChild(new Text(renderToolCallText(theme, item), 0, 0));
        }
        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(finalOutput.trim(), 0, 0));
        }
      }
      const usageStr = formatUsage(r.usage, r.model);
      if (usageStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", usageStr), 0, 0)); }
      return container;
    }

    let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))} (${r.agentSource})`;
    if (isError && r.stopReason) text += ` [${r.stopReason}]`;
    if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
    else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
    else text += `\n${renderItems(displayItems, 10, expanded, theme)}`;

    const usageStr = formatUsage(r.usage, r.model);
    if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
    return new Text(text, 0, 0);
  }

  const renderModeResults = (modeLabel: string, results: SubagentDetails["results"], limit: number, icon: string, status: string): Text | Container => {
    const displayItemsList = results.map((r) => getDisplayItems(r.messages));

    if (expanded) {
      const container = new Container();
      container.addChild(new Text(`${icon} ${modeLabel} (${status})`, 0, 0));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const displayItems = displayItemsList[i];
        const finalOutput = getFinalOutput(r.messages);
        container.addChild(new Spacer(1));
        const stepLabel = r.step !== undefined ? `─── Step ${r.step}: ${r.agent} ` : `─── ${r.agent} `;
        container.addChild(new Text(`${theme.fg("muted", stepLabel)}${r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")}`, 0, 0));
        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
        for (const item of displayItems) {
          container.addChild(new Text(renderToolCallText(theme, item), 0, 0));
        }
        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(finalOutput.trim(), 0, 0));
        }
        const taskUsage = formatUsage(r.usage, r.model);
        if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
      }
      const totalUsage = sumUsage(results);
      const usageStr = formatUsage(totalUsage);
      if (usageStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0)); }
      return container;
    }

    let text = `${icon} ${modeLabel} (${status})`;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const displayItems = displayItemsList[i];
      const stepLabel = r.step !== undefined ? `─── Step ${r.step}: ${r.agent} ` : `─── ${r.agent} `;
      text += `\n\n${theme.fg("muted", stepLabel)}${r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")}`;
      if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
      else text += `\n${renderItems(displayItems, limit, expanded, theme)}`;
    }
    if (!results.some((r) => r.exitCode === -1)) {
      const totalUsage = sumUsage(results);
      const usageStr = formatUsage(totalUsage);
      if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
    }
    text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  };

  // Chain mode
  if (details.mode === "chain") {
    const successCount = details.results.filter((r) => r.exitCode === 0).length;
    const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const status = `${successCount}/${details.results.length} steps`;
    return renderModeResults("chain", details.results, 5, icon, status);
  }

  // Batch mode
  if (details.mode === "batch") {
    const allSuccess = details.results.every((r) => r.exitCode === 0);
    const icon = allSuccess ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const status = `${details.results.length} tasks`;
    return renderModeResults("batch", details.results, 3, icon, status);
  }

  // Parallel mode
  if (details.mode === "parallel") {
    const running = details.results.filter((r) => r.exitCode === -1).length;
    const successCount = details.results.filter((r) => r.exitCode === 0).length;
    const failCount = details.results.filter((r) => r.exitCode > 0).length;
    const isRunning = running > 0;
    const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
    const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`;

    if (expanded && !isRunning) {
      const container = new Container();
      container.addChild(new Text(`${icon} parallel (${status})`, 0, 0));
      for (const r of details.results) {
        addResultToContainer(container, r, theme);
      }
      const totalUsage = sumUsage(details.results);
      const usageStr = formatUsage(totalUsage);
      if (usageStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0)); }
      return container;
    }

    let text = `${icon} parallel (${status})`;
    for (const r of details.results) {
      const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const displayItems = getDisplayItems(r.messages);
      text += `\n\n${theme.fg("muted", `─── ${r.agent} `)}${rIcon}`;
      if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
      else text += `\n${renderItems(displayItems, 5, expanded, theme)}`;
    }
    if (!isRunning) {
      const totalUsage = sumUsage(details.results);
      const usageStr = formatUsage(totalUsage);
      if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
    }
    if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  }

  const text = result.content[0];
  return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
