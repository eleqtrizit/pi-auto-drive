import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DriverRole, type DriverMessage } from "./transcript.ts";

/** Reply the driver sends when the goal is met. Auto-drive stops when it sees this token. */
export const DONE_TOKEN = "AUTO_DRIVE_DONE";

export const DRIVER_SYSTEM_PROMPT = `You are the human user of a coding agent. You direct its work.
The conversation shows what the agent said, plus one-line markers for the tools it called.
Your earlier messages are the instructions you (or the original human) gave it.

Each time the agent stops, reply with the next instruction for the agent. Rules:
- The goal is what the human asked for in the session. Push the agent until that goal is fully met.
- Never invent new tasks, features, or scope beyond that goal.
- Give one clear, concrete instruction. Do not write code yourself unless a short snippet is essential.
- If the agent asks a question, answer it with a decision.
- If the agent claims it is done, ask it to verify (tests, typecheck, lint) when it has not.
- Reply with the instruction text only. No preamble.
- When the goal is met, reply with exactly ${DONE_TOKEN} and nothing else. Trivial requests need no verification.`;

type DriverModel = NonNullable<ExtensionContext["model"]>;

/** Thrown when the driver model call fails. */
export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverError";
  }
}

/**
 * Asks the driver model for the next instruction. The call happens on the side and never enters the session.
 *
 * @returns The instruction, `null` when the driver replied with {@link DONE_TOKEN}, or `undefined` when aborted.
 * @throws DriverError when the model call fails or returns no text.
 */
export async function getNextInstruction(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: DriverModel,
  transcript: readonly DriverMessage[],
  signal: AbortSignal,
): Promise<string | null | undefined> {
  const messages = transcript.map((message) =>
    message.role === DriverRole.Agent
      ? { role: "user" as const, content: [{ type: "text" as const, text: message.text }], timestamp: Date.now() }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: message.text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        },
  );

  const response = await ctx.modelRegistry.complete(
    model,
    { systemPrompt: DRIVER_SYSTEM_PROMPT, messages },
    { signal, cacheRetention: "none" },
  );
  if (response.stopReason === "aborted") return undefined;
  if (response.stopReason === "error") throw new DriverError(response.errorMessage ?? "driver model request failed");

  const text = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new DriverError("driver model returned no text");
  return text === DONE_TOKEN ? null : text;
}
