import { spokenConsent } from "../shared/call-consent.ts";
import { CONSENT_SETTLE_MS } from "./live-call-controller.ts";

export type LiveCodexApprovalOutcome = "accept" | "decline" | "timeout";

export interface LiveCodexApprovalOptions {
  speak(text: string): void;
  onOutcome(outcome: LiveCodexApprovalOutcome): void;
  timeoutMs: number;
  /** Thread of the call. A request for another thread is declined. */
  threadId(): string | null;
  /** File names a file change request touches, or null when unknown. */
  files?(params: Record<string, unknown>): string[] | null;
  /** Quiet time after a final transcript before it is read as an answer. */
  settleMs?: number;
  /** Speaking rate that estimates when the voice's audio ends. */
  spokenCharsPerSecond?: number;
  /** Time after the estimated audio end in which user speech can still be the voice's echo. */
  echoTailMs?: number;
}

export interface LiveCodexApproval {
  /** True when the method is an approval request. The request is then answered through `respond`. */
  request(method: string, params: unknown, respond: (result: unknown) => void): boolean;
  /** One user transcript delta. The first delta of an utterance binds it to the question the person heard, if any. */
  userSpeech(): void;
  /** The final user transcript of one utterance. */
  heard(text: string): void;
  /** One transcript delta of the voice. The first delta of an output marks when its audio started. */
  voiceSpeech(): void;
  /** The final transcript of one voice output. */
  voiceDone(text: string): void;
  /** Decline an open request without an outcome. */
  dispose(): void;
}

export const COMMAND_SPOKEN_LIMIT = 120;
export const FILES_SPOKEN_LIMIT = 3;
/** About 150 words a minute. Realtime voices speak a little faster, so the estimate errs long. */
export const SPOKEN_CHARS_PER_SECOND = 14;
/** Playback buffer and transcription delay of the voice's audio heard back through the microphone. */
export const ECHO_TAIL_MS = 800;
const ANSWER_HINT = "Should I go ahead? Say yes or no.";
const NOTICE_COMMAND = "I need to run a command that I cannot read out in full, so I did not run it. Ask me in the chat to run it.";
const NOTICE_PERMISSIONS = "I need more access than I have now, so I did not do it. Ask me in the chat to allow it.";
const NOTICE_FILES = "I need to change files that I cannot read out in full, so I did not change them. Ask me in the chat to change them.";
const SEPARATORS = /[;|&`\n\r]|\$\(/;
const MIN_ECHO_WORDS = 3;

type Kind = "command" | "files" | "permissions";

const KINDS: Record<string, { kind: Kind; legacy: boolean }> = {
  "item/commandExecution/requestApproval": { kind: "command", legacy: false },
  "item/fileChange/requestApproval": { kind: "files", legacy: false },
  "item/permissions/requestApproval": { kind: "permissions", legacy: false },
  execCommandApproval: { kind: "command", legacy: true },
  applyPatchApproval: { kind: "files", legacy: true },
};

interface OpenRequest {
  question: string;
  spoken: boolean;
  settle(allow: boolean, outcome: LiveCodexApprovalOutcome | null): void;
}

interface VoiceOutput {
  startedAt: number;
  /** The open request whose question this output is, when it is the first output after the request opened. */
  asks: OpenRequest | null;
}

function commandText(params: Record<string, unknown>): string {
  const raw = params.command;
  return Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : typeof raw === "string" ? raw : "";
}

function grantedPermissions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined));
}

function reply(method: string, params: Record<string, unknown>, allow: boolean): unknown {
  const { kind, legacy } = KINDS[method]!;
  if (kind === "permissions") return { permissions: allow ? grantedPermissions(params.permissions) : {}, scope: "turn" };
  return { decision: allow ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" };
}

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** The voice's own question, heard again through the microphone. */
function isEcho(heard: string, question: string): boolean {
  const said = words(heard);
  if (said.length < MIN_ECHO_WORDS) return false;
  const asked = ` ${words(question).join(" ")} `;
  return asked.includes(` ${said.join(" ")} `);
}

function fileNames(fields: Record<string, unknown>, lookup: LiveCodexApprovalOptions["files"]): string[] | null {
  const legacy = fields.fileChanges;
  const names = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? Object.keys(legacy) : lookup?.(fields) ?? null;
  return names?.map((name) => name.split(/[\\/]/).filter(Boolean).pop() ?? name) ?? null;
}

function questionFor(kind: Kind, fields: Record<string, unknown>, lookup: LiveCodexApprovalOptions["files"]): { question: string } | { notice: string } {
  if (kind === "permissions" || fields.additionalPermissions != null || fields.networkApprovalContext != null || fields.grantRoot != null) {
    return { notice: NOTICE_PERMISSIONS };
  }
  if (kind === "command") {
    const command = commandText(fields);
    const plain = fields.kind == null || fields.kind === "command";
    if (!plain || !command.trim() || command.length > COMMAND_SPOKEN_LIMIT || SEPARATORS.test(command)) return { notice: NOTICE_COMMAND };
    return { question: `I need your OK to run this command: ${command}. ${ANSWER_HINT}` };
  }
  const names = fileNames(fields, lookup);
  if (!names?.length || names.length > FILES_SPOKEN_LIMIT) return { notice: NOTICE_FILES };
  return { question: `I need your OK to change ${names.length === 1 ? "this file" : "these files"}: ${names.join(", ")}. ${ANSWER_HINT}` };
}

export function createLiveCodexApproval(options: LiveCodexApprovalOptions): LiveCodexApproval {
  const settleMs = options.settleMs ?? CONSENT_SETTLE_MS;
  const charsPerSecond = options.spokenCharsPerSecond ?? SPOKEN_CHARS_PER_SECOND;
  const echoTailMs = options.echoTailMs ?? ECHO_TAIL_MS;
  let open: OpenRequest | null = null;
  let voice: VoiceOutput | null = null;
  let voiceQuietAt = 0;
  let utterance: { request: OpenRequest | null } | null = null;
  let pending: { request: OpenRequest; text: string } | null = null;
  let settleTimer: NodeJS.Timeout | null = null;

  const clearSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };
  const startVoice = (): VoiceOutput => ({ startedAt: Date.now(), asks: open && !open.spoken ? open : null });
  /** The open request, once the person has heard its question and the voice's echo has passed. */
  const answerable = (): OpenRequest | null => (open?.spoken && voice === null && Date.now() >= voiceQuietAt ? open : null);

  return {
    request(method, params, respond) {
      const entry = KINDS[method];
      if (!entry) return false;
      const fields = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
      const decline = (outcome: LiveCodexApprovalOutcome | null, notice?: string) => {
        respond(reply(method, fields, false));
        if (outcome) options.onOutcome(outcome);
        if (notice) options.speak(notice);
      };
      const thread = fields.threadId ?? fields.conversationId;
      if (typeof thread !== "string" || thread !== options.threadId()) {
        decline(null);
        return true;
      }
      if (open) {
        decline("decline");
        return true;
      }
      const asked = questionFor(entry.kind, fields, options.files);
      if ("notice" in asked) {
        decline("decline", asked.notice);
        return true;
      }

      let done = false;
      const timer = setTimeout(() => current.settle(false, "timeout"), options.timeoutMs);
      timer.unref?.();
      const current: OpenRequest = {
        question: asked.question,
        spoken: false,
        settle(allow, outcome) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearSettle();
          pending = null;
          if (open === current) open = null;
          respond(reply(method, fields, allow));
          if (outcome) options.onOutcome(outcome);
        },
      };
      open = current;
      options.speak(asked.question);
      return true;
    },
    userSpeech() {
      clearSettle();
      if (utterance) return;
      const request = answerable();
      utterance = { request };
      if (pending?.request !== request) pending = null;
    },
    heard(text) {
      const request = utterance?.request ?? null;
      utterance = null;
      if (!request || request !== open || !text.trim() || isEcho(text, request.question)) return;
      pending = { request, text: pending?.request === request ? `${pending.text} ${text}` : text };
      clearSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const said = pending;
        pending = null;
        if (!said || said.request !== open) return;
        const decision = spokenConsent(said.text, "live");
        if (decision !== null) said.request.settle(decision === "allow", decision === "allow" ? "accept" : "decline");
      }, settleMs);
      settleTimer.unref?.();
    },
    voiceSpeech() {
      voice ??= startVoice();
    },
    voiceDone(text) {
      const output = voice ?? startVoice();
      voice = null;
      const chars = Math.max(text.length, output.asks?.question.length ?? 0);
      const audioEnd = Math.max(Date.now(), output.startedAt + Math.ceil((chars * 1_000) / charsPerSecond));
      voiceQuietAt = Math.max(voiceQuietAt, audioEnd + echoTailMs);
      if (output.asks) output.asks.spoken = true;
    },
    dispose() {
      clearSettle();
      pending = null;
      open?.settle(false, null);
    },
  };
}
