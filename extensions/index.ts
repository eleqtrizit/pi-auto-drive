import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import { buildDriverTranscript } from "../src/transcript.ts";

const STATUS_KEY = "auto-drive";

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
    ctx.ui.setStatus(STATUS_KEY, `auto-drive ${turnsDriven}/${settings.cap}: asking ${settings.model}...`);
    let instruction: string | null | undefined;
    try {
      instruction = await getNextInstruction(ctx, model, transcript, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      disable(ctx, `driver failed: ${message}`, "error");
      return;
    } finally {
      inFlight = undefined;
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
    const items = (registry?.getAvailable() ?? [])
      .map((model) => `${model.provider}/${model.id}`)
      .filter((spec) => spec.startsWith(prefix))
      .map((spec) => ({ value: spec, label: spec }));
    return items.length > 0 ? items : null;
  };

  const setModel = async (args: string, ctx: ExtensionCommandContext, scope: "global" | "repo"): Promise<void> => {
    const command = scope === "global" ? Command.SetModelGlobal : Command.SetModelRepo;
    const specText = args.trim();
    const spec = parseModelSpec(specText);
    if (!spec) {
      ctx.ui.notify(`Usage: /${command} <provider/model>`, "error");
      return;
    }
    const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
    if (!model) {
      ctx.ui.notify(`Model ${specText} not found`, "error");
      return;
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify(`Model ${specText} has no configured auth`, "error");
      return;
    }
    const path = scope === "global" ? globalConfigPath(getAgentDir()) : repoConfigPath(ctx.cwd);
    await updateConfig(path, { model: specText });
    const override = scope === "repo" ? " Overrides the global model in this repo." : "";
    ctx.ui.notify(`Auto-drive ${scope} model set to ${specText} (${path}).${override}`, "info");
  };

  pi.registerCommand(Command.SetModelGlobal, {
    description: "Set the auto-drive model for all repos (provider/model)",
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
