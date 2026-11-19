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
}

export interface LiveCodexApproval {
  /** True when the method is an approval request. The request is then answered through `respond`. */
  request(method: string, params: unknown, respond: (result: unknown) => void): boolean;
  /** One user transcript delta. The first delta of an utterance marks when it started. */
  userSpeech(): void;
  /** The final user transcript of one utterance. */
  heard(text: string): void;
  /** Decline an open request without an outcome. */
  dispose(): void;
}

export const COMMAND_SPOKEN_LIMIT = 120;
export const FILES_SPOKEN_LIMIT = 3;
const ANSWER_HINT = "Do you allow it? Say yes or no.";
const NOTICE_COMMAND = "Codex asked to run a long command. I declined it. Ask in the chat to run it.";
const NOTICE_PERMISSIONS = "Codex asked for more permissions. I declined it. Ask in the chat to allow it.";
const NOTICE_FILES = "Codex asked to change files I cannot list in full. I declined it. Ask in the chat to allow it.";
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

function commandText(params: Record<string, unknown>): string {
  const raw = params.command;
  return Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : typeof raw === "string" ? raw : "";
}

function grantedPermissions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined));
}

function answer(method: string, params: Record<string, unknown>, allow: boolean): unknown {
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

export function createLiveCodexApproval(options: LiveCodexApprovalOptions): LiveCodexApproval {
  const settleMs = options.settleMs ?? CONSENT_SETTLE_MS;
  let open: { askedAt: number; question: string; settle(allow: boolean, outcome: LiveCodexApprovalOutcome | null): void } | null = null;
  let utterance: { valid: boolean } | null = null;
  let candidate = "";
  let settleTimer: NodeJS.Timeout | null = null;

  const clearSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };

  return {
    request(method, params, respond) {
      const entry = KINDS[method];
      if (!entry) return false;
      const fields = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
      const decline = (outcome: LiveCodexApprovalOutcome | null, notice?: string) => {
        respond(answer(method, fields, false));
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

      let question: string;
      if (entry.kind === "permissions") {
        decline("decline", NOTICE_PERMISSIONS);
        return true;
      }
      if (entry.kind === "command") {
        const command = commandText(fields);
        if (!command.trim() || command.length > COMMAND_SPOKEN_LIMIT || SEPARATORS.test(command)) {
          decline("decline", NOTICE_COMMAND);
          return true;
        }
        question = `Codex wants to run a command: ${command}. ${ANSWER_HINT}`;
      } else {
        const names = fileNames(fields, options.files);
        if (!names?.length || names.length > FILES_SPOKEN_LIMIT || fields.grantRoot) {
          decline("decline", NOTICE_FILES);
          return true;
        }
        question = `Codex wants to change ${names.length === 1 ? "this file" : "these files"}: ${names.join(", ")}. ${ANSWER_HINT}`;
      }

      let done = false;
      const timer = setTimeout(() => current.settle(false, "timeout"), options.timeoutMs);
      timer.unref?.();
      const current = {
        askedAt: Date.now(),
        question,
        settle(allow: boolean, outcome: LiveCodexApprovalOutcome | null) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearSettle();
          candidate = "";
          if (open === current) open = null;
          respond(answer(method, fields, allow));
          if (outcome) options.onOutcome(outcome);
        },
      };
      open = current;
      options.speak(question);
      return true;
    },
    userSpeech() {
      clearSettle();
      utterance ??= { valid: open !== null && Date.now() >= open.askedAt };
    },
    heard(text) {
      const started = utterance;
      utterance = null;
      if (!open || !started?.valid || !text.trim() || isEcho(text, open.question)) return;
      candidate = `${candidate} ${text}`.trim();
      clearSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const said = candidate;
        candidate = "";
        const decision = spokenConsent(said, "live");
        if (!open || decision === null) return;
        open.settle(decision === "allow", decision === "allow" ? "accept" : "decline");
      }, settleMs);
      settleTimer.unref?.();
    },
    dispose() {
      clearSettle();
      open?.settle(false, null);
    },
  };
}
