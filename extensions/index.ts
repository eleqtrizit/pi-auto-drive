import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import {
  globalConfigPath,
  parseCap,
  parseModelSpec,
  readConfig,
  repoConfigPath,
  resolveSettings,
  updateConfig,
  type ResolvedSettings,
} from "../src/config.ts";
import { getNextInstruction } from "../src/driver.ts";
import { matchModels, modelSpec } from "../src/models.ts";
import { buildDriverTranscript } from "../src/transcript.ts";

const STATUS_KEY = "auto-drive";
const SPINNER_KEY = "auto-drive-spinner";

enum Command {
  On = "auto-drive-on",
  Off = "auto-drive-off",
  SetModelGlobal = "set-auto-drive-model-global",
  SetModelRepo = "set-auto-drive-model-repo",
  SetCap = "set-auto-drive-cap",
}

const STOP_HINT = `If you want to stop auto drive, do \`/${Command.Off}\``;
const CAP_HINT = `Change it with \`/${Command.SetCap} <n>\``;

type ModelRegistry = ExtensionContext["modelRegistry"];
type DriverModel = NonNullable<ExtensionContext["model"]>;

/** Auto-drive extension: after each settled agent run, a side model plays the human and sends the next instruction. */
export default function autoDrive(pi: ExtensionAPI): void {
  let enabled = false;
  let turnsDriven = 0;
  let inFlight: AbortController | undefined;
  let registry: ModelRegistry | undefined;

  const loadSettings = async (cwd: string): Promise<ResolvedSettings> =>
    resolveSettings(await readConfig(globalConfigPath(getAgentDir())), await readConfig(repoConfigPath(cwd)));

  const updateStatus = (ctx: ExtensionContext, cap?: number): void => {
    ctx.ui.setStatus(STATUS_KEY, enabled ? `auto-drive ${turnsDriven}/${cap ?? "?"}` : undefined);
  };

  const disable = (ctx: ExtensionContext, reason: string, level: "info" | "warning" | "error" = "info"): void => {
    enabled = false;
    inFlight?.abort();
    updateStatus(ctx);
    ctx.ui.notify(`Auto-drive off: ${reason}`, level);
  };

  const resolveModel = (ctx: ExtensionContext, settings: ResolvedSettings): DriverModel | string => {
    if (!settings.model) {
      return `no driver model set. Use /${Command.SetModelGlobal} or /${Command.SetModelRepo} <provider/model>`;
    }
    const spec = parseModelSpec(settings.model);
    const model = spec && ctx.modelRegistry.find(spec.provider, spec.modelId);
    return model ?? `driver model ${settings.model} (${settings.modelSource}) not found`;
  };

  /** Shows an animated loader above the editor, matching the built-in "Working" indicator. */
  const showSpinner = (ctx: ExtensionContext, message: string): void => {
    ctx.ui.setWidget(SPINNER_KEY, (tui, theme) => {
      const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), message);
      // The widget host calls dispose() on removal; stop the animation timer so it does not leak.
      return Object.assign(loader, { dispose: () => loader.stop() });
    });
  };

  const drive = async (ctx: ExtensionContext): Promise<void> => {
    if (!enabled || inFlight) return;
    const settings = await loadSettings(ctx.cwd);
    updateStatus(ctx, settings.cap);
    if (turnsDriven >= settings.cap) {
      disable(ctx, `reached the cap of ${settings.cap} turns. ${CAP_HINT}`, "warning");
      return;
    }
    const model = resolveModel(ctx, settings);
    if (typeof model === "string") {
      disable(ctx, model, "error");
      return;
    }

    const transcript = buildDriverTranscript(ctx.sessionManager.buildContextEntries());
    if (transcript.length === 0) return;

    const controller = new AbortController();
    inFlight = controller;
    showSpinner(ctx, `Auto Driving (turn: ${turnsDriven + 1}, limit: ${settings.cap})`);
    let instruction: string | null | undefined;
    try {
      instruction = await getNextInstruction(ctx, model, transcript, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      disable(ctx, `driver failed: ${message}`, "error");
      return;
    } finally {
      inFlight = undefined;
      ctx.ui.setWidget(SPINNER_KEY, undefined);
    }

    // Aborted by /auto-drive-off, or superseded by typed input. The next agent_settled drives again.
    if (!enabled || instruction === undefined) {
      updateStatus(ctx, settings.cap);
      return;
    }
    if (instruction === null) {
      disable(ctx, "the driver reports the goal is met");
      return;
    }

    turnsDriven += 1;
    updateStatus(ctx, settings.cap);
    ctx.ui.notify(`Auto-drive (${turnsDriven}/${settings.cap}): ${instruction}`, "info");
    pi.sendUserMessage(instruction, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  };

  const runDrive = (ctx: ExtensionContext): void => {
    drive(ctx).catch((error: unknown) => disable(ctx, `unexpected error: ${String(error)}`, "error"));
  };

  pi.on("session_start", async (_event, ctx) => {
    registry = ctx.modelRegistry;
    enabled = false;
    turnsDriven = 0;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    enabled = false;
    inFlight?.abort();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (enabled) runDrive(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (enabled && event.source === "interactive") {
      inFlight?.abort();
      ctx.ui.notify(STOP_HINT, "info");
    }
    return { action: "continue" };
  });

  const modelCompletions = (prefix: string) => {
    const items = matchModels(registry?.getAvailable() ?? [], prefix).map((model) => ({
      value: modelSpec(model),
      label: modelSpec(model),
      description: model.name,
    }));
    return items.length > 0 ? items : null;
  };

  /** Resolves a partial query to one model, asking the user to pick when several match. */
  const pickModel = async (ctx: ExtensionCommandContext, query: string): Promise<DriverModel | undefined> => {
    const matches = matchModels(ctx.modelRegistry.getAvailable(), query);
    if (matches.length <= 1 || !ctx.hasUI) return matches.length === 1 ? matches[0] : undefined;
    const choice = await ctx.ui.select(`Models matching "${query}"`, matches.map(modelSpec));
    return matches.find((model) => modelSpec(model) === choice);
  };

  const setModel = async (args: string, ctx: ExtensionCommandContext, scope: "global" | "repo"): Promise<void> => {
    const command = scope === "global" ? Command.SetModelGlobal : Command.SetModelRepo;
    const query = args.trim();
    if (!query) {
      ctx.ui.notify(`Usage: /${command} <model name or provider/model>`, "error");
      return;
    }
    const model = await pickModel(ctx, query);
    if (!model) {
      ctx.ui.notify(`No available model matches "${query}"`, "error");
      return;
    }
    const spec = modelSpec(model);
    const path = scope === "global" ? globalConfigPath(getAgentDir()) : repoConfigPath(ctx.cwd);
    await updateConfig(path, { model: spec });
    const override = scope === "repo" ? " Overrides the global model in this repo." : "";
    ctx.ui.notify(`Auto-drive ${scope} model set to ${spec} (${path}).${override}`, "info");
  };

  pi.registerCommand(Command.SetModelGlobal, {
    description: "Set the auto-drive model for all repos",
    getArgumentCompletions: modelCompletions,
    handler: (args, ctx) => setModel(args, ctx, "global"),
  });

  pi.registerCommand(Command.SetModelRepo, {
    description: "Set the auto-drive model for this repo; overrides the global model",
    getArgumentCompletions: modelCompletions,
    handler: (args, ctx) => setModel(args, ctx, "repo"),
  });

  pi.registerCommand(Command.SetCap, {
    description: "Set the maximum number of auto-driven turns",
    handler: async (args, ctx) => {
      const cap = parseCap(args);
      if (cap === undefined) {
        ctx.ui.notify(`Usage: /${Command.SetCap} <positive integer>`, "error");
        return;
      }
      await updateConfig(globalConfigPath(getAgentDir()), { cap });
      ctx.ui.notify(`Auto-drive cap set to ${cap} turns`, "info");
      if (enabled) updateStatus(ctx, cap);
    },
  });

  pi.registerCommand(Command.On, {
    description: "Let the auto-drive model play the human after each agent turn",
    handler: async (_args, ctx) => {
      const settings = await loadSettings(ctx.cwd);
      const model = resolveModel(ctx, settings);
      if (typeof model === "string") {
        ctx.ui.notify(`Auto-drive not started: ${model}`, "error");
        return;
      }
      enabled = true;
      turnsDriven = 0;
      updateStatus(ctx, settings.cap);
      const empty = buildDriverTranscript(ctx.sessionManager.buildContextEntries()).length === 0;
      // One notify call: consecutive info notifications replace each other in the TUI.
      ctx.ui.notify(
        [
          `Auto-drive on with ${settings.model} (${settings.modelSource}).`,
          `Turn cap: ${settings.cap}. ${CAP_HINT}.`,
          STOP_HINT,
          ...(empty ? ["Send the first message to set the goal."] : []),
        ].join("\n"),
        "info",
      );
      if (ctx.isIdle()) runDrive(ctx);
    },
  });

  pi.registerCommand(Command.Off, {
    description: "Stop auto-drive",
    handler: async (_args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("Auto-drive is already off", "info");
        return;
      }
      disable(ctx, `stopped after ${turnsDriven} driven turns`);
    },
  });
}
