import {
  getAgentDir,
  type ExtensionAPI,
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
import { ModelPicker, orderScopedFirst } from "../src/model-picker.ts";
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

type ModelScope = "global" | "repo";
const MODEL_COMMANDS: Record<ModelScope, Command> = { global: Command.SetModelGlobal, repo: Command.SetModelRepo };

const STOP_HINT = `If you want to stop auto drive, do \`/${Command.Off}\``;
const CAP_HINT = `Change it with \`/${Command.SetCap} <n>\``;

type DriverModel = NonNullable<ExtensionContext["model"]>;

/** Auto-drive extension: after each settled agent run, a side model plays the human and sends the next instruction. */
export default function autoDrive(pi: ExtensionAPI): void {
  let enabled = false;
  let turnsDriven = 0;
  let inFlight: AbortController | undefined;
  let sessionCtx: ExtensionContext | undefined;
  let stopWatchingEditor: (() => void) | undefined;

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
    sessionCtx = ctx;
    stopWatchingEditor?.();
    stopWatchingEditor = ctx.mode === "tui" ? watchEditorForModelCommand(ctx) : undefined;
    enabled = false;
    turnsDriven = 0;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatchingEditor?.();
    stopWatchingEditor = undefined;
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

  /** Available models with session-scoped models first. */
  const orderedModels = (ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">): DriverModel[] =>
    orderScopedFirst(
      ctx.modelRegistry.getAvailable(),
      ctx.scopedModels.map((scoped) => scoped.model),
    );

  const modelCompletions = (prefix: string) => {
    if (!sessionCtx) return null;
    const items = matchModels(orderedModels(sessionCtx), prefix).map((model) => ({
      value: modelSpec(model),
      label: modelSpec(model),
    }));
    return items.length > 0 ? items : null;
  };

  /** Opens the searchable model picker. Resolves undefined when cancelled or when no TUI is available. */
  const openPicker = async (ctx: ExtensionContext, title: string, query = ""): Promise<DriverModel | undefined> => {
    if (ctx.mode !== "tui") return undefined;
    const models = orderedModels(ctx);
    const scopedSpecs = new Set(ctx.scopedModels.map((scoped) => modelSpec(scoped.model)));
    return ctx.ui.custom<DriverModel | undefined>(
      (tui, theme, _kb, done) => new ModelPicker(tui, theme, title, models, scopedSpecs, done, query),
    );
  };

  /** Resolves a query to one model. A single match is used directly; otherwise the picker opens. */
  const pickModel = async (ctx: ExtensionContext, title: string, query: string): Promise<DriverModel | undefined> => {
    const matches = query ? matchModels(orderedModels(ctx), query) : [];
    if (matches.length === 1) return matches[0];
    return openPicker(ctx, title, query);
  };

  const setModel = async (args: string, ctx: ExtensionContext, scope: ModelScope): Promise<void> => {
    const command = MODEL_COMMANDS[scope];
    const query = args.trim();
    const model = await pickModel(ctx, `Auto-drive ${scope} model`, query);
    if (!model) {
      if (ctx.mode !== "tui" && !query) ctx.ui.notify(`Usage: /${command} <model name or provider/model>`, "error");
      else if (query && ctx.mode !== "tui") ctx.ui.notify(`No single available model matches "${query}"`, "error");
      return;
    }
    const spec = modelSpec(model);
    const path = scope === "global" ? globalConfigPath(getAgentDir()) : repoConfigPath(ctx.cwd);
    await updateConfig(path, { model: spec });
    const override = scope === "repo" ? " Overrides the global model in this repo." : "";
    ctx.ui.notify(`Auto-drive ${scope} model set to ${spec} (${path}).${override}`, "info");
  };

  /**
   * Opens the picker as soon as the editor holds exactly `/<set-model-command> ` (typed space or Tab completion).
   * Runs after the editor has processed the key, so it sees the updated text.
   */
  const watchEditorForModelCommand = (ctx: ExtensionContext): (() => void) =>
    ctx.ui.onTerminalInput(() => {
      setImmediate(() => {
        // Session replacement invalidates the captured ctx; the session_start
        // handler re-registers this watcher on the fresh ctx, so skip stale ticks.
        try {
          const text = ctx.ui.getEditorText();
          const scope = (Object.keys(MODEL_COMMANDS) as ModelScope[]).find((key) => text === `/${MODEL_COMMANDS[key]} `);
          if (!scope) return;
          ctx.ui.setEditorText("");
          setModel("", ctx, scope).catch((error: unknown) => ctx.ui.notify(`Set model failed: ${String(error)}`, "error"));
        } catch {
          // Stale ctx after session replacement: this tick is obsolete.
        }
      });
      return undefined;
    });

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
