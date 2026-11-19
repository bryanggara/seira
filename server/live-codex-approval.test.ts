import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveCodexApproval, type LiveCodexApprovalOutcome } from "./live-codex-approval.ts";

const COMMAND = "item/commandExecution/requestApproval";

function setup(timeoutMs = 60_000) {
  const spoken: string[] = [];
  const outcomes: LiveCodexApprovalOutcome[] = [];
  const approval = createLiveCodexApproval({ speak: (text) => spoken.push(text), onOutcome: (outcome) => outcomes.push(outcome), timeoutMs });
  const respond = vi.fn();
  return { approval, spoken, outcomes, respond };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("live Codex approval by voice", () => {
  it("asks about a command and accepts on a clear yes", () => {
    const { approval, spoken, outcomes, respond } = setup();
    expect(approval.request(COMMAND, { command: "ls -la" }, respond)).toBe(true);
    expect(spoken).toEqual(["Codex wants to run a command: ls -la. Do you allow it? Say yes or no."]);
    approval.heard("Yes.");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
  });

  it("declines on a clear no", () => {
    const { approval, outcomes, respond } = setup();
    approval.request(COMMAND, { command: "rm -rf scratch" }, respond);
    approval.heard("no, don't");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
  });

  it("keeps waiting on words that are not a clear answer", () => {
    const { approval, outcomes, respond } = setup();
    approval.request(COMMAND, { command: "ls" }, respond);
    approval.heard("wait, what does it delete?");
    approval.heard("okay");
    expect(respond).not.toHaveBeenCalled();
    approval.heard("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
  });

  it("cuts a long command to 120 characters on one line", () => {
    const { approval, spoken, respond } = setup();
    approval.request(COMMAND, { command: `echo ${"x".repeat(300)}\nsecond line` }, respond);
    const command = /run a command: (.*)\. Do you allow it\?/.exec(spoken[0]!)![1]!;
    expect(command).toHaveLength(120);
    expect(command.endsWith("...")).toBe(true);
    expect(command).not.toContain("\n");
  });

  it("asks without the command text when none is given", () => {
    const { approval, spoken, respond } = setup();
    approval.request(COMMAND, {}, respond);
    expect(spoken).toEqual(["Codex wants to run a command. Do you allow it? Say yes or no."]);
  });

  it("declines and reports a timeout when no clear answer comes", () => {
    const { approval, outcomes, respond } = setup(60_000);
    approval.request(COMMAND, { command: "ls" }, respond);
    vi.advanceTimersByTime(59_999);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["timeout"]);
    approval.heard("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines a second request at once and keeps the first open", () => {
    const { approval, outcomes, respond, spoken } = setup();
    const second = vi.fn();
    approval.request(COMMAND, { command: "first" }, respond);
    expect(approval.request("item/fileChange/requestApproval", {}, second)).toBe(true);
    expect(second).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toHaveLength(1);
    expect(respond).not.toHaveBeenCalled();
    approval.heard("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("answers a file change request", () => {
    const { approval, spoken, respond } = setup();
    approval.request("item/fileChange/requestApproval", { itemId: "i" }, respond);
    expect(spoken).toEqual(["Codex wants to change files. Do you allow it? Say yes or no."]);
    approval.heard("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("uses the legacy answers for the legacy requests", () => {
    const yes = setup();
    const accepted = vi.fn();
    yes.approval.request("execCommandApproval", { command: ["git", "status"] }, accepted);
    expect(yes.spoken[0]).toContain("git status");
    yes.approval.heard("yes");
    expect(accepted).toHaveBeenCalledExactlyOnceWith({ decision: "approved" });

    const no = setup();
    const refused = vi.fn();
    no.approval.request("applyPatchApproval", {}, refused);
    no.approval.heard("no");
    expect(refused).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
  });

  it("grants only the permission families that were asked for", () => {
    const yes = setup();
    const granted = vi.fn();
    const permissions = { network: { enabled: true }, fileSystem: null };
    yes.approval.request("item/permissions/requestApproval", { permissions }, granted);
    yes.approval.heard("yes");
    expect(granted).toHaveBeenCalledExactlyOnceWith({ permissions: { network: { enabled: true } }, scope: "turn" });

    const no = setup();
    const denied = vi.fn();
    no.approval.request("item/permissions/requestApproval", { permissions }, denied);
    no.approval.heard("no");
    expect(denied).toHaveBeenCalledExactlyOnceWith({ permissions: {}, scope: "turn" });
  });

  it("leaves other methods alone", () => {
    const { approval, spoken, respond } = setup();
    expect(approval.request("item/tool/requestUserInput", {}, respond)).toBe(false);
    expect(approval.request("mcpServer/elicitation/request", {}, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual([]);
  });

  it("ignores speech when nothing is open", () => {
    const { approval, outcomes } = setup();
    approval.heard("yes");
    expect(outcomes).toEqual([]);
  });

  it("declines an open request on dispose without an outcome", () => {
    const { approval, outcomes, respond } = setup();
    approval.request(COMMAND, { command: "ls" }, respond);
    approval.dispose();
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(respond).toHaveBeenCalledTimes(1);
  });
});
