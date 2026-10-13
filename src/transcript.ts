import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** Role from the driver's point of view. The driver plays the human, so it is the "assistant". */
export enum DriverRole {
  /** Messages the driver reads: what the coding agent said and did. */
  Agent = "user",
  /** Messages the driver wrote: what the human (or driver) told the agent. */
  Driver = "assistant",
}

/** One message in the driver's role-swapped, text-only transcript. */
export interface DriverMessage {
  role: DriverRole;
  text: string;
}

type AgentMessage = SessionMessageEntry["message"];

const MAX_MARKER_ARGS_LENGTH = 100;
const SESSION_START_NOTE = "[Session start. Give the coding agent its first instruction.]";
const NO_REPLY_NOTE = "[The agent stopped without a text reply.]";

/** Formats a tool call as a one-line marker such as `[tool: bash {"command":"npm test"}]`. */
export function formatToolMarker(name: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args ?? {}).replace(/\s+/g, " ");
  const shown = json.length > MAX_MARKER_ARGS_LENGTH ? `${json.slice(0, MAX_MARKER_ARGS_LENGTH)}…` : json;
  return `[tool: ${name} ${shown}]`;
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

/** Converts one agent message to a driver message, or undefined when it carries nothing useful. */
function convertMessage(message: AgentMessage): DriverMessage | undefined {
  switch (message.role) {
    case "user":
      return { role: DriverRole.Driver, text: textOf(message.content) };
    case "assistant": {
      const lines = message.content.flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "toolCall") return [formatToolMarker(part.name, part.arguments)];
        return [];
      });
      if (message.stopReason === "error" && message.errorMessage) lines.push(`[error: ${message.errorMessage}]`);
      return { role: DriverRole.Agent, text: lines.join("\n") };
    }
    case "bashExecution":
      if (message.excludeFromContext) return undefined;
      return { role: DriverRole.Driver, text: `[ran shell: ${message.command}]` };
    case "compactionSummary":
    case "branchSummary":
      return { role: DriverRole.Agent, text: `[Summary of earlier work]\n${message.summary}` };
    default:
      // Tool results and custom extension messages are dropped. Tool markers already record the call.
      return undefined;
  }
}

function entryToMessages(entry: SessionEntry): AgentMessage[] {
  if (entry.type === "message") return [entry.message];
  if (entry.type === "compaction") {
    return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: 0 }];
  }
  if (entry.type === "branch_summary") {
    return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: 0 }];
  }
  return [];
}

/**
 * Builds the driver's view of the session.
 *
 * Swaps user and assistant roles, keeps only text plus one-line tool markers, and merges
 * consecutive same-role messages. The result always starts and ends with an agent message,
 * so the driver model replies as the human.
 *
 * @param entries - Compaction-aware context entries, as returned by `buildContextEntries()`.
 * @returns The role-swapped transcript. Empty when the session has no conversation.
 */
export function buildDriverTranscript(entries: readonly SessionEntry[]): DriverMessage[] {
  const merged: DriverMessage[] = [];
  for (const message of entries.flatMap(entryToMessages)) {
    const converted = convertMessage(message);
    const text = converted?.text.trim();
    if (!converted || !text) continue;
    const last = merged.at(-1);
    if (last?.role === converted.role) last.text = `${last.text}\n\n${text}`;
    else merged.push({ role: converted.role, text });
  }
  if (merged.length === 0) return merged;
  if (merged[0].role === DriverRole.Driver) merged.unshift({ role: DriverRole.Agent, text: SESSION_START_NOTE });
  if (merged.at(-1)?.role === DriverRole.Driver) merged.push({ role: DriverRole.Agent, text: NO_REPLY_NOTE });
  return merged;
}
