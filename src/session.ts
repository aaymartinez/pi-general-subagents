// ─── Session Hashing ────────────────────────────────────────────────
//
// Creates a deterministic session hash from agent name and task.
// Used with --session flag so Pi creates/restores the same session.
// This enables session persistence: stalled agents can resume from their last state.

export function createSessionHash(agentName: string, task: string): string {
  const hash = task
    .split("")
    .reduce((acc, c) => (((acc << 5) - acc + c.charCodeAt(0)) | 0) >>> 0, 0)
    .toString(16)
    .slice(0, 8);
  return `${agentName}-${hash}`;
}
