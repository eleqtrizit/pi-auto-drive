import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildDriverTranscript, DriverRole, formatToolMarker } from "../src/transcript.ts";

const base = { id: "x", parentId: null, timestamp: "2024-01-01T00:00:00.000Z" };
const user = (text: string) =>
  ({ ...base, type: "message", message: { role: "user", content: text, timestamp: 0 } }) as SessionEntry;
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ ...base, type: "message", message: { role: "assistant", content, stopReason: "stop", ...extra } }) as SessionEntry;
const toolResult = () =>
  ({
    ...base,
    type: "message",
    message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "OUT" }] },
  }) as SessionEntry;

describe("buildDriverTranscript", () => {
  it("returns empty for an empty session", () => {
    expect(buildDriverTranscript([])).toEqual([]);
  });

  it("swaps roles, keeps text and tool markers, drops thinking and tool results, merges runs", () => {
    const result = buildDriverTranscript([
      user("fix the bug"),
      assistant([
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } },
      ]),
      toolResult(),
      assistant([{ type: "text", text: "Fixed." }]),
    ]);
    expect(result).toEqual([
      { role: DriverRole.Agent, text: expect.stringContaining("Session start") },
      { role: DriverRole.Driver, text: "fix the bug" },
      { role: DriverRole.Agent, text: 'Looking.\n[tool: bash {"command":"npm test"}]\n\nFixed.' },
    ]);
  });

  it("ends with an agent message when the agent produced no text", () => {
    const result = buildDriverTranscript([user("go"), assistant([{ type: "thinking", thinking: "hm" }])]);
    expect(result.at(-1)).toEqual({ role: DriverRole.Agent, text: expect.stringContaining("without a text reply") });
  });

  it("starts with the compaction summary as an agent message", () => {
    const compaction = { ...base, type: "compaction", summary: "did X", firstKeptEntryId: "x", tokensBefore: 1 };
    const result = buildDriverTranscript([compaction as SessionEntry, user("next"), assistant([{ type: "text", text: "ok" }])]);
    expect(result.map((m) => m.role)).toEqual([DriverRole.Agent, DriverRole.Driver, DriverRole.Agent]);
    expect(result[0].text).toContain("did X");
  });

  it("records agent errors", () => {
    const result = buildDriverTranscript([user("go"), assistant([], { stopReason: "error", errorMessage: "boom" })]);
    expect(result.at(-1)?.text).toBe("[error: boom]");
  });
});

describe("formatToolMarker", () => {
  it("truncates long arguments", () => {
    const marker = formatToolMarker("write", { content: "a".repeat(500) });
    expect(marker.length).toBeLessThan(130);
    expect(marker).toMatch(/^\[tool: write .*…\]$/);
  });
});
