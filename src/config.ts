import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CONFIG_FILE_NAME = "pi-auto-drive.json";
export const DEFAULT_TURN_CAP = 50;

/** Settings stored in one config file. All fields are optional. */
export interface AutoDriveConfig {
  /** Driver model as `provider/modelId`. */
  model?: string;
  /** Maximum driven turns per `/auto-drive-on`. */
  cap?: number;
}

/** Thrown when a config file exists but cannot be parsed. */
export class AutoDriveConfigError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Invalid config file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AutoDriveConfigError";
  }
}

/** Global config path: `<agentDir>/pi-auto-drive.json`. */
export const globalConfigPath = (agentDir: string): string => join(agentDir, CONFIG_FILE_NAME);

/** Repo config path: `<cwd>/.pi/pi-auto-drive.json`. */
export const repoConfigPath = (cwd: string): string => join(cwd, ".pi", CONFIG_FILE_NAME);

/**
 * Reads a config file.
 *
 * @returns The parsed config, or an empty config when the file does not exist.
 * @throws AutoDriveConfigError when the file is not a JSON object.
 */
export async function readConfig(path: string): Promise<AutoDriveConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
    return parsed as AutoDriveConfig;
  } catch (error) {
    throw new AutoDriveConfigError(path, error);
  }
}

/** Merges `patch` into the config file at `path`, creating the file and its directory when needed. */
export async function updateConfig(path: string, patch: AutoDriveConfig): Promise<void> {
  const next = { ...(await readConfig(path)), ...patch };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Resolved settings. The repo model overrides the global model. */
export interface ResolvedSettings {
  model?: string;
  modelSource?: "repo" | "global";
  cap: number;
}

/** Combines global and repo config. Only the model has a repo override; the cap is global. */
export function resolveSettings(global: AutoDriveConfig, repo: AutoDriveConfig): ResolvedSettings {
  const cap = global.cap ?? DEFAULT_TURN_CAP;
  if (repo.model) return { model: repo.model, modelSource: "repo", cap };
  if (global.model) return { model: global.model, modelSource: "global", cap };
  return { cap };
}

/**
 * Splits `provider/modelId` at the first slash. Model ids can contain slashes (for example OpenRouter ids).
 *
 * @returns The parts, or undefined when the spec has no provider or no model id.
 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Parses a positive integer turn cap.
 *
 * @returns The cap, or undefined when the input is not a positive integer.
 */
export function parseCap(input: string): number | undefined {
  const value = Number(input.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
