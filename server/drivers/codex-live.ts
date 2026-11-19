import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import {
  EngineLiveVoiceError,
  type EngineLiveVoiceEvent,
  type EngineLiveVoiceSession,
  type EngineLiveVoiceStart,
} from "../contracts.ts";
import { createLiveCodexApproval } from "../live-codex-approval.ts";

/** `thread/realtime/start` with `version: "v3"` and WebRTC exists from Codex 0.170.0. */
export const LIVE_VOICE_MIN_CODEX = [0, 170, 0] as const;

export type LiveCodexChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface CodexLiveTimeouts {
  /** Wait for the SDP answer after `thread/realtime/start`. */
  answerMs: number;
  /** Wait for `thread/realtime/stop` to answer. */
  stopMs: number;
  /** Wait after each signal for the process to exit. */
  killMs: number;
  /** Wait for a spoken answer to an approval question. */
  approvalMs: number;
  /** Wait for each other request. */
  rpcMs: number;
}

export interface CodexLiveDeps {
  /** True when this Codex uses the Seira plan token, an endpoint or a managed key. Live then refuses. */
  unsupportedSignIn: boolean;
  /** Environment of the child process, built like the one for chat turns. */
  env(): Record<string, string | undefined>;
  /** Output of `--version`, or null when unknown. */
  version(): Promise<string | null>;
  /** Thread fields for an approval mode, preferred first. `effectiveConfig` is set for the custom mode. */
  threadParams(mode: ApprovalMode, effectiveConfig: unknown): ReadonlyArray<Record<string, unknown>>;
  /** Start `codex` with these arguments. */
  spawn(args: string[], options: { cwd: string; env: Record<string, string | undefined> }): LiveCodexChild;
  /** Send a signal to the process and its children. */
  terminate?(child: LiveCodexChild, signal: "SIGTERM" | "SIGKILL"): void;
  clientVersion: string;
  /** Receives counters and outcomes only. */
  log(line: string): void;
  timeouts?: Partial<CodexLiveTimeouts>;
}

export interface CodexLiveVoice {
  start(input: EngineLiveVoiceStart): Promise<EngineLiveVoiceSession>;
  dispose(): Promise<void>;
}

const DEFAULT_TIMEOUTS: CodexLiveTimeouts = { answerMs: 20_000, stopMs: 2_000, killMs: 2_000, approvalMs: 60_000, rpcMs: 30_000 };
const FINAL_EXIT_WAIT_MS = 500;

export function codexVersionTooOld(output: string | null): boolean {
  const found = output ? /(\d+)\.(\d+)\.(\d+)/.exec(output) : null;
  if (!found) return false;
  for (let index = 0; index < 3; index++) {
    const have = Number(found[index + 1]);
    const need = LIVE_VOICE_MIN_CODEX[index]!;
    if (have !== need) return have < need;
  }
  return false;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

export function codexLiveVoice(deps: CodexLiveDeps): CodexLiveVoice {
  const timeouts: CodexLiveTimeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const open = new Set<{ stop(): Promise<void> }>();

  const refuse = (refusal: EngineLiveVoiceError["refusal"]): never => {
    deps.log(`live codex: refused ${refusal}`);
    throw new EngineLiveVoiceError(refusal);
  };

  async function start(input: EngineLiveVoiceStart): Promise<EngineLiveVoiceSession> {
    if (deps.unsupportedSignIn) refuse("unsupported-sign-in");
    if (codexVersionTooOld(await deps.version().catch(() => null))) refuse("too-old");

    let child: LiveCodexChild;
    try {
      child = deps.spawn(["app-server"], { cwd: input.cwd, env: deps.env() });
    } catch {
      return refuse("failed");
    }

    let exited = false;
    let stopping = false;
    let threadId: string | null = null;
    let established = false;
    let nextId = 1;
    let keptAnswer = "";
    const counts = { transcripts: 0, answers: 0, approvals: 0, appends: 0, speeches: 0, appendFailures: 0 };
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let onSdp: ((sdp: string) => void) | null = null;
    let onEarlyFailure: (() => void) | null = null;

    const exitWaiters = new Set<() => void>();
    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* the exit handler reports a dead process */ }
    };
    const request = (method: string, params: unknown, ms = timeouts.rpcMs): Promise<any> => new Promise((resolve, reject) => {
      if (exited) return reject(new Error("exited"));
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, ms);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });

    const emit = (event: EngineLiveVoiceEvent) => {
      if (stopping) return;
      try { input.onEvent(event); } catch { /* a listener failure must not stop the call */ }
    };
    const appendSpeech = (text: string) => {
      if (stopping || exited || !threadId) return;
      counts.speeches++;
      request("thread/realtime/appendSpeech", { threadId, text }).catch(() => { counts.appendFailures++; });
    };
    const approval = createLiveCodexApproval({
      speak: appendSpeech,
      onOutcome: (outcome) => { counts.approvals++; emit({ type: "approval", outcome }); },
      timeoutMs: timeouts.approvalMs,
    });

    const terminate = async () => {
      if (exited) return;
      const exitedWithin = (ms: number) => Promise.race([
        new Promise<boolean>((resolve) => { exitWaiters.add(() => resolve(true)); }),
        wait(ms).then(() => false),
      ]);
      const signal = (name: "SIGTERM" | "SIGKILL") => {
        try {
          if (deps.terminate) deps.terminate(child, name); else child.kill(name);
        } catch { /* the process is already gone */ }
      };
      signal("SIGTERM");
      if (await exitedWithin(timeouts.killMs)) return;
      signal("SIGKILL");
      await exitedWithin(Math.min(timeouts.killMs, FINAL_EXIT_WAIT_MS));
    };

    const markExited = () => {
      if (exited) return;
      exited = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("exited")); }
      pending.clear();
      for (const waiter of exitWaiters) waiter();
      exitWaiters.clear();
      approval.dispose();
      if (stopping) return;
      if (established) emit({ type: "failed", reason: "exit" });
      else onEarlyFailure?.();
    };
    child.on("exit", markExited);
    child.on("error", markExited);
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});

    const forThread = (params: any) => threadId !== null && (params?.threadId === undefined || params.threadId === threadId);
    const onNotification = (method: string, params: any) => {
      if (method === "thread/realtime/sdp") {
        if (forThread(params) && typeof params?.sdp === "string") onSdp?.(params.sdp);
        return;
      }
      if (!forThread(params)) return;
      switch (method) {
        case "thread/realtime/started":
          emit({ type: "started" });
          break;
        case "thread/realtime/transcript/delta":
          if ((params.role === "user" || params.role === "assistant") && typeof params.delta === "string") {
            counts.transcripts++;
            emit({ type: "transcript", role: params.role, delta: params.delta });
          }
          break;
        case "thread/realtime/transcript/done":
          if (params.role === "user" && typeof params.text === "string") approval.heard(params.text);
          break;
        case "item/completed":
          if (params.item?.type === "agentMessage" && typeof params.item.text === "string" && params.item.text.trim()) {
            keptAnswer = params.item.text;
          }
          break;
        case "turn/completed":
          if (keptAnswer) {
            const text = keptAnswer;
            keptAnswer = "";
            counts.answers++;
            emit({ type: "answer", text });
          }
          break;
        case "thread/realtime/closed":
          emit({ type: "closed", reason: typeof params.reason === "string" ? params.reason : null });
          break;
        case "thread/realtime/error":
          emit({ type: "failed", reason: "error" });
          break;
      }
    };
    const onServerRequest = (id: unknown, method: string, params: unknown) => {
      const handled = approval.request(method, params, (result) => send({ jsonrpc: "2.0", id, result }));
      if (handled) return;
      if (method === "mcpServer/elicitation/request") send({ jsonrpc: "2.0", id, result: { action: "decline" } });
      else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
    };

    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message === null || typeof message !== "object") return;
      if (typeof message.method === "string") {
        if (message.id !== undefined) onServerRequest(message.id, message.method, message.params);
        else onNotification(message.method, message.params);
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error("rpc"));
      else entry.resolve(message.result);
    });

    let stopOnce: Promise<void> | undefined;
    const session: { stop(): Promise<void> } = {
      stop: () => stopOnce ??= (async () => {
        stopping = true;
        approval.dispose();
        if (!exited && threadId) await Promise.race([request("thread/realtime/stop", { threadId }, timeouts.stopMs).catch(() => {}), wait(timeouts.stopMs)]);
        await terminate();
        open.delete(session);
        deps.log(`live codex: stopped transcripts=${counts.transcripts} answers=${counts.answers} approvals=${counts.approvals} appends=${counts.appends} speeches=${counts.speeches} failedAppends=${counts.appendFailures}`);
      })(),
    };
    open.add(session);

    let sdp: string;
    try {
      await request("initialize", {
        clientInfo: { name: "seira_live", title: "Seira Live", version: deps.clientVersion },
        capabilities: { experimentalApi: true },
      });
      send({ jsonrpc: "2.0", method: "initialized", params: {} });

      const account = await request("account/read", { refreshToken: false });
      if (account?.account?.type !== "chatgpt") {
        await terminate();
        open.delete(session);
        return refuse("not-signed-in");
      }

      const effectiveConfig = input.approvalMode === "custom"
        ? (await request("config/read", { cwd: input.cwd, includeLayers: false }))?.config
        : undefined;
      let started: any;
      let startError: unknown;
      for (const fields of deps.threadParams(input.approvalMode, effectiveConfig)) {
        try {
          started = await request("thread/start", { cwd: input.cwd, ...fields, ephemeral: false });
          break;
        } catch (error) { startError = error; }
      }
      if (!started) throw startError ?? new Error("thread");
      const id = started?.thread?.id;
      if (typeof id !== "string" || !id) throw new Error("thread");
      threadId = id;

      const initialItems = [
        { role: "developer", text: input.voiceInstructions },
        ...input.history.map(({ role, text }) => ({ role, text })),
      ].filter((item) => item.text.trim() !== "");

      sdp = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new EngineLiveVoiceError("no-answer")), timeouts.answerMs);
        timer.unref?.();
        onSdp = (answer) => { clearTimeout(timer); resolve(answer); };
        onEarlyFailure = () => { clearTimeout(timer); reject(new EngineLiveVoiceError("failed")); };
        request("thread/realtime/start", {
          threadId: id,
          outputModality: "audio",
          includeStartupContext: false,
          transport: { type: "webrtc", sdp: input.sdp },
          version: "v3",
          realtimeSessionId: id,
          initialItems,
          ...(input.workInstructions.trim() ? { realtimeStartInstructions: input.workInstructions } : {}),
        }, timeouts.answerMs).catch(() => {
          if (established) { emit({ type: "failed", reason: "error" }); return; }
          clearTimeout(timer);
          reject(new EngineLiveVoiceError("failed"));
        });
      }).finally(() => { onSdp = null; onEarlyFailure = null; });
    } catch (error) {
      if (error instanceof EngineLiveVoiceError && error.refusal === "not-signed-in") throw error;
      await terminate();
      open.delete(session);
      const refusal = error instanceof EngineLiveVoiceError ? error.refusal : "failed";
      return refuse(refusal);
    }

    established = true;
    deps.log("live codex: started");
    return {
      sdp,
      appendText(text) {
        if (stopping || exited || !threadId) return;
        counts.appends++;
        request("thread/realtime/appendText", { threadId, text, role: "developer" }).catch(() => { counts.appendFailures++; });
      },
      appendSpeech,
      stop: session.stop,
    };
  }

  return {
    start,
    async dispose() {
      await Promise.all([...open].map((session) => session.stop()));
    },
  };
}
