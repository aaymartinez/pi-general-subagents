// ─── Evidence Extraction ────────────────────────────────────────────
// Parses child Pi process output to detect observable work:
// - Tool calls made (read, write, edit, bash, grep, find, ls)
// - Files written/modified
// - Bash commands executed
// - Model output tokens

import type { SingleResult } from "./types";

export interface Evidence {
  type: "tool_call" | "file_write" | "file_edit" | "bash_command" | "model_output";
  count: number;
  details?: string[];
}

export function extractEvidence(result: SingleResult): Evidence[] {
  const evidence: Evidence[] = [];

  // Parse messages for tool calls and file operations
  for (const msg of result.messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          const toolName = part.name;
          const args = typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments);

          if (toolName === "write") {
            const files = extractFileWrites(args);
            if (files.length > 0) {
              evidence.push({ type: "file_write", count: files.length, details: files });
            }
          } else if (toolName === "edit") {
            const files = extractFileEdits(args);
            if (files.length > 0) {
              evidence.push({ type: "file_edit", count: files.length, details: files });
            }
          } else if (toolName === "bash") {
            const commands = extractBashCommands(args);
            if (commands.length > 0) {
              evidence.push({ type: "bash_command", count: commands.length, details: commands });
            }
          } else {
            evidence.push({ type: "tool_call", count: 1, details: [toolName] });
          }
        }
      }
    }
  }

  // Count model output tokens
  if (result.usage.output > 0) {
    evidence.push({ type: "model_output", count: result.usage.output, details: [`${result.usage.output} tokens`] });
  }

  return evidence;
}

function extractFileWrites(args: string): string[] {
  const files: string[] = [];
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    if (parsed.path) files.push(parsed.path);
    if (parsed.paths && Array.isArray(parsed.paths)) files.push(...parsed.paths);
  } catch {
    // If we can't parse, try to extract file paths from the raw string
    const match = args.match(/"(?:[^"\\]|\\.)*\.ts"/);
    if (match) files.push(match[0]);
  }
  return files;
}

function extractFileEdits(args: string): string[] {
  const files: string[] = [];
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    if (parsed.path) files.push(parsed.path);
  } catch {
    const match = args.match(/"(?:[^"\\]|\\.)*\.ts"/);
    if (match) files.push(match[0]);
  }
  return files;
}

function extractBashCommands(args: string): string[] {
  const commands: string[] = [];
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    if (parsed.command) commands.push(parsed.command);
    if (parsed.commands && Array.isArray(parsed.commands)) commands.push(...parsed.commands);
  } catch {
    // Try to extract bash commands from raw string
    const match = args.match(/`([^`]+)`/);
    if (match) commands.push(match[1]);
  }
  return commands;
}
