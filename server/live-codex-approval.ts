import { spokenConsent } from "../shared/call-consent.ts";

export type LiveCodexApprovalOutcome = "accept" | "decline" | "timeout";

export interface LiveCodexApprovalOptions {
  speak(text: string): void;
  onOutcome(outcome: LiveCodexApprovalOutcome): void;
  timeoutMs: number;
}

export interface LiveCodexApproval {
  /** True when the method is an approval request. The request is then answered through `respond`. */
  request(method: string, params: unknown, respond: (result: unknown) => void): boolean;
  /** Feed one final user transcript. */
  heard(text: string): void;
  /** Decline an open request without an outcome. */
  dispose(): void;
}

const COMMAND_LIMIT = 120;
const ANSWER_HINT = "Do you allow it? Say yes or no.";

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
  const text = Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : typeof raw === "string" ? raw : "";
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > COMMAND_LIMIT ? `${single.slice(0, COMMAND_LIMIT - 3)}...` : single;
}

function question(kind: Kind, params: Record<string, unknown>): string {
  if (kind === "command") {
    const command = commandText(params);
    return command ? `Codex wants to run a command: ${command}. ${ANSWER_HINT}` : `Codex wants to run a command. ${ANSWER_HINT}`;
  }
  if (kind === "files") return `Codex wants to change files. ${ANSWER_HINT}`;
  return `Codex asks for more permissions. ${ANSWER_HINT}`;
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

export function createLiveCodexApproval(options: LiveCodexApprovalOptions): LiveCodexApproval {
  let open: { settle(allow: boolean, outcome: LiveCodexApprovalOutcome | null): void } | null = null;

  return {
    request(method, params, respond) {
      const entry = KINDS[method];
      if (!entry) return false;
      const fields = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
      if (open) {
        respond(answer(method, fields, false));
        options.onOutcome("decline");
        return true;
      }
      let done = false;
      const timer = setTimeout(() => current.settle(false, "timeout"), options.timeoutMs);
      timer.unref?.();
      const current = {
        settle(allow: boolean, outcome: LiveCodexApprovalOutcome | null) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (open === current) open = null;
          respond(answer(method, fields, allow));
          if (outcome) options.onOutcome(outcome);
        },
      };
      open = current;
      options.speak(question(entry.kind, fields));
      return true;
    },
    heard(text) {
      const decision = spokenConsent(text, "live");
      if (!open || decision === null) return;
      open.settle(decision === "allow", decision === "allow" ? "accept" : "decline");
    },
    dispose() {
      open?.settle(false, null);
    },
  };
}
