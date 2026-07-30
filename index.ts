/**
 * General Subagents Extension
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window, its own persona, skills, and tools.
 *
 * This is a generic, reusable extension — any project or skill can use it
 * to delegate work to specialized agents.
 *
 * Modes:
 *   - single: One agent, one task
 *   - chain: Sequential steps with {previous} placeholder for prior output
 *   - parallel: Multiple tasks simultaneously (concurrency-limited)
 *   - batch: Staged pipeline — results after each stage for review
 *
 * Agents are loaded from .pi/agents/*.md (project-local) or ~/.pi/agent/agents/*.md (user-level).
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	type SingleResult,
	type SubagentDetails,
	type OnUpdateCallback,
	isResultError,
	mapWithConcurrencyLimit,
	runSingleAgent,
	getEventsFile,
	appendEvent,
	initEvents,
	getFinalOutput,
	discoverAgents,
	renderCall,
	renderResult,
	BatchParams,
	ListAgentsParams,
	AgentScopeSchema,
	SubagentParams,
} from "./src/lib";
import {
	loadSubagentsSettings,
	getMaxParallel,
	getMaxConcurrency,
} from "./src/subagents-settings";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
	// ─── list_agents ────────────────────────────────────────────────
	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: [
			"List all available subagents and their configurations.",
			"Useful for discovering which agents exist and what tools they have.",
			"Default scope: 'project' (project-local agents). Use 'user' for global agents, 'both' for all.",
		].join(" "),
		parameters: ListAgentsParams,

		async execute(
			_toolCallId,
			_rawListParams,
			_signal,
			_onUpdate,
			ctx,
		): Promise<any> {
			const params = _rawListParams as any;
			const scope: AgentScope = params.agentScope ?? "project";

			// Check for agentsDir override in subagents.json
			const settings = loadSubagentsSettings(ctx.cwd);
			const customAgentsDir = settings.agentsDir || null;

			const discovery = discoverAgents(ctx.cwd, scope, customAgentsDir);
			const agents = discovery.agents;

			if (agents.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No agents found in the configured scope.",
						},
					],
				};
			}

			const list = agents
				.map((a: AgentConfig) => {
					const tools = a.tools ? `[${a.tools.join(", ")}]` : "[all]";
					const model = a.model ? ` (model: ${a.model})` : "";
					const source = a.source === "user" ? "global" : "project";
					return `  - ${a.name} (${a.name}) (${source}): ${a.description} ${tools}${model}`;
				})
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Available agents (${agents.length}):\n\n${list}`,
					},
				],
			};
		},
		renderCall: (args, theme, _ctx) => renderCall(args, theme),
		renderResult: (result, _expanded, theme, _ctx) => {
			const text = result.content[0];
			return new Text(
				text?.type === "text" ? text.text : "(no output)",
				0,
				0,
			);
		},
	});

	// ─── subagent ───────────────────────────────────────────────────
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents with isolated context windows.",
			"Each subagent runs in its own pi subprocess with its own session, persona, skills, and tools.",
			"Modes: single (agent + task), chain (sequential with {previous} placeholder), parallel (tasks array), batch (staged pipeline).",
			"Agents are loaded from .pi/agents/*.md (project-local) or ~/.pi/agent/agents/*.md (user-level).",
			"Batch mode runs the pipeline in stages — you review results after each stage before continuing.",
			"Event system: writes pipeline-events.json for state tracking and audit trail.",
		].join(" "),
		parameters: SubagentParams,

		async execute(
			_toolCallId,
			_rawParams,
			signal,
			onUpdate,
			ctx,
		): Promise<any> {
			// Hard block: subagents cannot spawn other subagents.
			// Two independent checks — env var may not propagate on Windows (cmd /c pi.cmd wrapper),
			// so the sentinel file provides a reliable fallback.
			const isSubagentEnv = !!(
				process.env.SUBAGENT_IS_RUNNING || process.env.SUBAGENT_NAME
			);
			const sentinelPath = path.join(ctx.cwd, ".subagent-running");
			const isSubagentFile = fs.existsSync(sentinelPath);
			if (isSubagentEnv || isSubagentFile) {
				const agentName = process.env.SUBAGENT_NAME || "subagent";
				return {
					content: [
						{
							type: "text",
							text: `❌ BLOCKED: subagent cannot be called from within a subagent. This is working as intended — NOT a configuration error. You are the ${agentName} agent. Do NOT retry subagent — every attempt will be blocked. Do NOT read SKILL.md or other agents' files. Complete your specific job now using read, write, bash, grep, and find.`,
						},
					],
				};
			}

			// Normalize params — LLMs often send malformed params
			let params: any = _rawParams;

			// Handle string params: "agent task description"
			if (typeof params === "string") {
				const parts = params.split(" ");
				params = {
					mode: "single",
					agent: parts[0],
					task: parts.slice(1).join(" "),
				};
			} else if (params && typeof params === "object") {
				// JSON format but missing mode field — agent and task are present
				if (!params.mode && params.agent && params.task) {
					params = { ...params, mode: "single" };
				}
				// Two-key object — likely positional args passed as {0: agent, 1: task} or similar
				else if (!params.mode && Object.keys(params).length === 2) {
					const keys = Object.keys(params).sort(
						(a, b) => Number(a) - Number(b),
					);
					params = {
						mode: "single",
						agent: params[keys[0]] || "",
						task: params[keys[1]] || "",
					};
				}
				// Array-style positional: [agent, task] or {0: agent, 1: task}
				else if (!params.mode && params[0] && params[1]) {
					const keys = Object.keys(params).sort(
						(a, b) => Number(a) - Number(b),
					);
					params = {
						mode: "single",
						agent: params[keys[0]] || "",
						task: params[keys[1]] || "",
					};
				}
				// Single-key object — LLM passed positional args as {"agentName": "task"}
				else if (!params.mode && Object.keys(params).length === 1) {
					const keys = Object.keys(params);
					params = {
						mode: "single",
						agent: keys[0] || "",
						task: String(params[keys[0]] || ""),
					};
				}
			}

			// Ensure mode is set
			if (!params?.mode) {
				return {
					content: [
						{
							type: "text",
							text: "Missing 'mode' parameter. Use: single, chain, parallel, or batch.",
						},
					],
				};
			}

			const agentScope: AgentScope = params.agentScope ?? "project";

			// ─── Load Runtime Settings First ─────────────────────────────
			// Try params.cwd first (subprocess working dir), then fall back to ctx.cwd.
			// This allows other workspaces to use their own subagents.json
			// even when the main process is running from a different directory.
			const discoveryCwd = params.cwd || ctx.cwd;
			const settings = loadSubagentsSettings(discoveryCwd);
			const customAgentsDir = settings.agentsDir || null;

			const discovery = discoverAgents(
				discoveryCwd,
				agentScope,
				customAgentsDir,
			);
			const agents = discovery.agents;

			// ─── Use Settings for Runtime Config ─────────────────────────
			// If agentsDir was used, reload settings from that directory's parent
			// so subagents.json is read from the correct location.
			const effectiveSettingsDir = customAgentsDir
				? path.dirname(customAgentsDir)
				: discovery.projectAgentsDir;
			const effectiveSettings =
				loadSubagentsSettings(effectiveSettingsDir);

			const mode = params.mode;
			const hasChain =
				mode === "chain" && (params.chain?.length ?? 0) > 0;
			const hasTasks =
				mode === "parallel" && (params.tasks?.length ?? 0) > 0;
			const hasSingle =
				mode === "single" && Boolean(params.agent && params.task);
			const hasBatch =
				mode === "batch" && (params.stages?.length ?? 0) > 0;
			const modeCount =
				Number(hasChain) +
				Number(hasTasks) +
				Number(hasSingle) +
				Number(hasBatch);

			const globalTimeout = params.timeout;
			const globalOutputFormat = params.outputFormat;

			// Extract project folder from task text: "Workspace: <path>"
			function extractProjectCwd(task: string): string {
				const match = task.match(/Workspace:\s*([^"]\S*|"[^"]+")/i);
				if (!match) return "";
				const raw = match[1].replace(/\/$/, "");
				return raw.replace(/^"|"$/g, "").trim();
			}

			// Collect workspace path from all tasks in any mode
			function extractFirstWorkspace(): string {
				if (params.task) return extractProjectCwd(params.task);
				if (params.chain) {
					for (const step of params.chain) {
						const p = extractProjectCwd(step.task);
						if (p) return p;
					}
				}
				if (params.tasks) {
					for (const t of params.tasks) {
						const p = extractProjectCwd(t.task);
						if (p) return p;
					}
				}
				if (params.stages) {
					for (const stage of params.stages) {
						for (const t of stage.tasks) {
							const p = extractProjectCwd(t.task);
							if (p) return p;
						}
					}
				}
				return "";
			}

			const taskProjectCwd = extractFirstWorkspace();
			const defaultProjectDir = path.join(
				ctx.cwd,
				"workspace",
				"personal",
			);
			const globalCwd = params.cwd || taskProjectCwd || defaultProjectDir;
			// Ensure project directory exists before writing events into it
			try {
				fs.mkdirSync(globalCwd, { recursive: true });
			} catch {
				/* ignore */
			}
			// Subprocess cwd must be project root so Pi can discover .pi/ config
			const subagentCwd = ctx.cwd;

			const eventsFile = getEventsFile(globalCwd);
			const concept =
				params.task ||
				params.chain?.[0]?.task?.slice(0, 100) ||
				"Pipeline";

			const makeDetails =
				(mode: "single" | "chain" | "parallel" | "batch") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					sessions: {},
				});

			if (modeCount !== 1) {
				const available = agents
					.map((a: AgentConfig) => `"${a.name}"`)
					.join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode. Available agents: ${available || "none"}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// ─── BATCH MODE ───────────────────────────────────────────────
			if (params.stages && params.stages.length > 0) {
				const batchResults: {
					stage: string;
					results: SingleResult[];
					status: "done" | "stopped";
					successCount: number;
					failedCount: number;
				}[] = [];

				initEvents(eventsFile, concept, "batch-pipeline");

				for (
					let stageIdx = 0;
					stageIdx < params.stages.length;
					stageIdx++
				) {
					const stage = params.stages[stageIdx];
					const stageCwd =
						params.cwd ||
						extractProjectCwd(stage.tasks[0]?.task || "") ||
						subagentCwd;
					const stageTimeout = stage.timeout ?? globalTimeout;
					const stageOutputFormat =
						stage.outputFormat ?? globalOutputFormat;

					appendEvent(eventsFile, {
						time: new Date().toISOString(),
						agent: "system",
						phase: stage.name,
						type: "stage-start",
						text: `Stage "${stage.name}" started`,
					});

					const stageResults: SingleResult[] = new Array(
						stage.tasks.length,
					);
					for (let i = 0; i < stage.tasks.length; i++) {
						stageResults[i] = {
							agent: stage.tasks[i].agent,
							agentSource: "unknown",
							task: stage.tasks[i].task,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 0,
								turns: 0,
							},
						};
					}

					const emitBatchUpdate = () => {
						if (onUpdate) {
							const done = stageResults.filter(
								(r) => r.exitCode !== -1,
							).length;
							const running = stageResults.filter(
								(r) => r.exitCode === -1,
							).length;
							onUpdate({
								content: [
									{
										type: "text",
										text: `Stage "${stage.name}": ${done}/${stage.tasks.length} done, ${running} running...`,
									},
								],
								details: makeDetails("batch")([
									...batchResults
										.map((b) => b.results)
										.flat(),
									...stageResults.filter(
										(r) => r.exitCode !== -1,
									),
								]),
							});
						}
					};

					await mapWithConcurrencyLimit(
						stage.tasks,
						getMaxConcurrency(effectiveSettings),
						async (t: any, index) => {
							if (signal?.aborted) return null as any;
							const result = await runSingleAgent(
								agents,
								t.agent,
								t.task,
								stageCwd,
								eventsFile,
								stage.name,
								undefined,
								signal,
								(partial) => {
									if (partial.details?.results[0]) {
										stageResults[index] =
											partial.details.results[0];
										emitBatchUpdate();
									}
								},
								makeDetails("batch"),
								effectiveSettings,
								stageTimeout,
								stageOutputFormat,
								t.thinkingLevel ?? params.thinkingLevel,
							);
							stageResults[index] = result;
							emitBatchUpdate();
							return result;
						},
					);

					const successCount = stageResults.filter(
						(r) => r.exitCode === 0,
					).length;
					const failed = stageResults.filter((r) => r.exitCode !== 0);

					appendEvent(eventsFile, {
						time: new Date().toISOString(),
						agent: "system",
						phase: stage.name,
						type: "stage-complete",
						text: `Stage "${stage.name}": ${successCount}/${stage.tasks.length} tasks completed`,
					});

					batchResults.push({
						stage: stage.name,
						results: stageResults,
						status:
							failed.length > 0
								? ("stopped" as const)
								: ("done" as const),
						successCount,
						failedCount: failed.length,
					});

					if (failed.length > 0) {
						const failNames = failed
							.map(
								(f) =>
									`${f.agent} (${f.stopReason || f.exitCode})`,
							)
							.join(", ");
						appendEvent(eventsFile, {
							time: new Date().toISOString(),
							agent: "system",
							phase: stage.name,
							type: "stage-failed",
							text: `Batch stopped at stage "${stage.name}": ${failNames}`,
						});
						return {
							content: [
								{
									type: "text",
									text: `Batch stopped at stage "${stage.name}": ${failNames}`,
								},
							],
							details: makeDetails("batch")([
								...batchResults.map((b) => b.results).flat(),
							]),
							isError: true,
						};
					}
				}

				appendEvent(eventsFile, {
					time: new Date().toISOString(),
					agent: "system",
					phase: "batch-pipeline",
					type: "pipeline-complete",
					text: "Batch pipeline completed successfully",
				});

				const allResults = batchResults.flatMap((b) => b.results);
				const summary = batchResults
					.map(
						(b) =>
							`Stage "${b.stage}": ${b.successCount}/${b.results.length} tasks completed`,
					)
					.join("\n");

				return {
					content: [
						{
							type: "text",
							text: `Batch pipeline complete:\n\n${summary}\n\n${allResults.length} total tasks across ${batchResults.length} stages`,
						},
					],
					details: makeDetails("batch")(allResults),
				};
			}

			// ─── CHAIN MODE ───────────────────────────────────────────────
			if (params.chain && params.chain.length > 0) {
				initEvents(eventsFile, concept, "chain");

				const results: SingleResult[] = [];

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const stepCwd = step.cwd ?? subagentCwd;

					// Build task with {previous} replacement
					let compressedTask = step.task;
					if (i > 0 && results.length > 0) {
						const prevResult = results[i - 1];
						const prevOutput = getFinalOutput(prevResult.messages);
						const preview = prevOutput
							.replace(/\n/g, " ")
							.replace(/\s+/g, " ")
							.slice(0, 200);
						const status =
							prevResult.exitCode === 0
								? "completed"
								: `failed (${prevResult.stopReason || prevResult.exitCode})`;
						const replacement = `[${status}] ${preview}`;
						compressedTask = step.task.replace(
							/\{previous\}/g,
							replacement,
						);
					}

					const stepTimeout = step.timeout ?? globalTimeout;
					const stepOutputFormat =
						step.outputFormat ?? globalOutputFormat;

					appendEvent(eventsFile, {
						time: new Date().toISOString(),
						agent: step.agent,
						phase: `step-${i + 1}`,
						type: "step-start",
						text: `Step ${i + 1}: ${step.agent} started`,
					});

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult =
									partial.details?.results[0];
								if (currentResult) {
									onUpdate({
										content: partial.content as any,
										details: makeDetails("chain")([
											...results,
											currentResult,
										] as any) as any,
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						agents,
						step.agent,
						compressedTask,
						stepCwd,
						eventsFile,
						`step-${i + 1}`,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						settings,
						stepTimeout,
						stepOutputFormat,
						step.thinkingLevel ?? params.thinkingLevel,
					);
					results.push(result);

					if (isResultError(result)) {
						const errorMsg =
							result.errorMessage ||
							result.stderr ||
							getFinalOutput(result.messages) ||
							"(no output)";
						appendEvent(eventsFile, {
							time: new Date().toISOString(),
							agent: step.agent,
							phase: `step-${i + 1}`,
							type: "step-failed",
							text: `Chain failed at step ${i + 1} (${step.agent}): ${errorMsg}`,
						});
						return {
							content: [
								{
									type: "text",
									text: `Chain failed at step ${i + 1} (${step.agent}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
				}

				appendEvent(eventsFile, {
					time: new Date().toISOString(),
					agent: "system",
					phase: "chain",
					type: "chain-complete",
					text: `Chain completed: ${results.length} steps`,
				});

				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(
									results[results.length - 1].messages,
								) || "(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			// ─── PARALLEL MODE ────────────────────────────────────────────
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > getMaxParallel(effectiveSettings)) {
					return {
						content: [
							{
								type: "text",
								text: `Max ${getMaxParallel(effectiveSettings)} parallel tasks. Got ${params.tasks.length}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}

				initEvents(eventsFile, concept, "parallel");

				const allResults: SingleResult[] = new Array(
					params.tasks.length,
				);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter(
							(r) => r.exitCode === -1,
						).length;
						const done = allResults.filter(
							(r) => r.exitCode !== -1,
						).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					getMaxConcurrency(effectiveSettings),
					async (t: any, index) => {
						if (signal?.aborted) return null as any;
						const stepTimeout = t.timeout ?? globalTimeout;
						const stepOutputFormat =
							t.outputFormat ?? globalOutputFormat;
						const stepThinkingLevel =
							t.thinkingLevel ?? params.thinkingLevel;
						const result = await runSingleAgent(
							agents,
							t.agent,
							t.task,
							subagentCwd,
							eventsFile,
							"parallel",
							undefined,
							signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] =
										partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							effectiveSettings,
							stepTimeout,
							stepOutputFormat,
							stepThinkingLevel,
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter(
					(r) => r.exitCode === 0,
				).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview =
						output.slice(0, 100) +
						(output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});

				appendEvent(eventsFile, {
					time: new Date().toISOString(),
					agent: "system",
					phase: "parallel",
					type: "parallel-complete",
					text: `Parallel: ${successCount}/${results.length} succeeded`,
				});

				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// ─── SINGLE MODE ──────────────────────────────────────────────
			if (params.agent && params.task) {
				initEvents(eventsFile, concept, params.agent);

				const result = await runSingleAgent(
					agents,
					params.agent,
					params.task,
					subagentCwd,
					eventsFile,
					params.agent,
					undefined,
					signal,
					onUpdate as any,
					makeDetails("single"),
					effectiveSettings,
					globalTimeout,
					globalOutputFormat,
					params.thinkingLevel,
				);
				if (isResultError(result)) {
					const errorMsg =
						result.errorMessage ||
						result.stderr ||
						getFinalOutput(result.messages) ||
						"(no output)";
					appendEvent(eventsFile, {
						time: new Date().toISOString(),
						agent: params.agent,
						phase: params.agent,
						type: "task-failed",
						text: `${params.agent}: ${errorMsg}`,
					});
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(result.messages) ||
								"(no output)",
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${agents.map((a: AgentConfig) => `"${a.name}"`).join(", ") || "none"}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall: (args, theme, _context) => renderCall(args, theme),
		renderResult: (result, { expanded }, theme, _context) =>
			renderResult(result as any, { expanded }, theme),
	});
}
