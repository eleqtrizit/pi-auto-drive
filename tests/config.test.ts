import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AutoDriveConfigError,
  DEFAULT_TURN_CAP,
  parseCap,
  parseModelSpec,
  readConfig,
  resolveSettings,
  updateConfig,
} from "../src/config.ts";

describe("resolveSettings", () => {
  it("prefers the repo model and defaults the cap", () => {
    expect(resolveSettings({ model: "a/g" }, { model: "b/r" })).toEqual({
      model: "b/r",
      modelSource: "repo",
      cap: DEFAULT_TURN_CAP,
    });
  });
  it("falls back to the global model and cap", () => {
    expect(resolveSettings({ model: "a/g", cap: 3 }, {})).toEqual({ model: "a/g", modelSource: "global", cap: 3 });
  });
  it("has no model when neither is set", () => {
    expect(resolveSettings({}, {})).toEqual({ cap: DEFAULT_TURN_CAP });
  });
});

describe("parsers", () => {
  it("splits model specs at the first slash", () => {
    expect(parseModelSpec("openrouter/meta/llama")).toEqual({ provider: "openrouter", modelId: "meta/llama" });
    expect(parseModelSpec("nope")).toBeUndefined();
    expect(parseModelSpec("/x")).toBeUndefined();
    expect(parseModelSpec("x/")).toBeUndefined();
  });
  it("accepts only positive integer caps", () => {
    expect(parseCap(" 10 ")).toBe(10);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) expect(parseCap(bad)).toBeUndefined();
  });
});

describe("config files", () => {
  it("returns empty for a missing file and merges updates", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "auto-drive-")), "nested", "c.json");
    expect(await readConfig(path)).toEqual({});
    await updateConfig(path, { model: "a/b" });
    await updateConfig(path, { cap: 7 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "a/b", cap: 7 });
  });
  it("throws on invalid JSON", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "auto-drive-")), "c.json");
    await writeFile(path, "[1]");
    await expect(readConfig(path)).rejects.toBeInstanceOf(AutoDriveConfigError);
  });
});
