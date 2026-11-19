import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveCodexApproval, type LiveCodexApprovalOptions, type LiveCodexApprovalOutcome } from "./live-codex-approval.ts";

const COMMAND = "item/commandExecution/requestApproval";
const FILES = "item/fileChange/requestApproval";
const PERMISSIONS = "item/permissions/requestApproval";
const THREAD = "thread-1";
const SETTLE = 1_200;
const LONG_COMMAND = "Codex asked to run a long command. I declined it. Ask in the chat to run it.";

function setup(extra: Partial<LiveCodexApprovalOptions> = {}) {
  const spoken: string[] = [];
  const outcomes: LiveCodexApprovalOutcome[] = [];
  const approval = createLiveCodexApproval({
    speak: (text) => spoken.push(text),
    onOutcome: (outcome) => outcomes.push(outcome),
    timeoutMs: 60_000,
    threadId: () => THREAD,
    ...extra,
  });
  const respond = vi.fn();
  const ask = (command = "ls -la") => approval.request(COMMAND, { threadId: THREAD, command }, respond);
  /** One whole utterance: a delta, then the final text, then the settle window. */
  const say = (text: string, settle = SETTLE) => {
    approval.userSpeech();
    approval.heard(text);
    vi.advanceTimersByTime(settle);
  };
  return { approval, spoken, outcomes, respond, ask, say };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("live Codex approval by voice", () => {
  it("asks about a command and accepts on a clear yes after the settle window", () => {
    const { approval, spoken, outcomes, respond, ask, say } = setup();
    expect(ask()).toBe(true);
    expect(spoken).toEqual(["Codex wants to run a command: ls -la. Do you allow it? Say yes or no."]);
    approval.userSpeech();
    approval.heard("Yes.");
    vi.advanceTimersByTime(SETTLE - 1);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
    say("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines on a clear no", () => {
    const { outcomes, respond, ask, say } = setup();
    ask("rm -rf scratch");
    say("no, don't");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
  });

  it("keeps waiting on words that are not a clear answer", () => {
    const { outcomes, respond, ask, say } = setup();
    ask("ls");
    say("wait, what does it delete?");
    say("okay");
    expect(respond).not.toHaveBeenCalled();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
  });

  it("uses a transcript for one decision only", () => {
    const { approval, respond, ask, say } = setup();
    ask("ls");
    say("yes");
    const second = vi.fn();
    approval.request(COMMAND, { threadId: THREAD, command: "pwd" }, second);
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("holds the decision while the person keeps talking", () => {
    const { approval, respond, ask, say } = setup();
    ask("ls");
    say("yes", SETTLE - 100);
    approval.userSpeech();
    vi.advanceTimersByTime(5_000);
    expect(respond).not.toHaveBeenCalled();
  });

  it("declines and reports a timeout when no clear answer comes", () => {
    const { outcomes, respond, ask, say } = setup({ timeoutMs: 60_000 });
    ask();
    vi.advanceTimersByTime(59_999);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["timeout"]);
    say("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines a second request at once and keeps the first open", () => {
    const { approval, outcomes, respond, spoken, ask, say } = setup();
    const second = vi.fn();
    ask("first");
    expect(approval.request(COMMAND, { threadId: THREAD, command: "second" }, second)).toBe(true);
    expect(second).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toHaveLength(1);
    expect(respond).not.toHaveBeenCalled();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("uses the legacy answers for the legacy requests", () => {
    const yes = setup();
    const accepted = vi.fn();
    yes.approval.request("execCommandApproval", { conversationId: THREAD, command: ["git", "status"] }, accepted);
    expect(yes.spoken[0]).toContain("git status");
    yes.say("yes");
    expect(accepted).toHaveBeenCalledExactlyOnceWith({ decision: "approved" });

    const no = setup();
    const refused = vi.fn();
    no.approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges: { "a.ts": {} } }, refused);
    no.say("no");
    expect(refused).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
  });

  it("leaves other methods alone", () => {
    const { approval, spoken, respond } = setup();
    expect(approval.request("item/tool/requestUserInput", {}, respond)).toBe(false);
    expect(approval.request("mcpServer/elicitation/request", {}, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual([]);
  });

  it("ignores speech when nothing is open", () => {
    const { outcomes, say } = setup();
    say("yes");
    expect(outcomes).toEqual([]);
  });

  it("declines an open request on dispose without an outcome", () => {
    const { approval, outcomes, respond, ask } = setup();
    ask();
    approval.dispose();
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(respond).toHaveBeenCalledTimes(1);
  });
});

describe("live Codex approval consent guards", () => {
  it("ignores the question heard again through the microphone", () => {
    const { spoken, respond, outcomes, ask, say } = setup();
    ask("ls -la");
    say("Codex wants to run a command ls la. Do you allow it? Say yes or no.");
    say("do you allow it say yes or no");
    expect(respond).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    expect(spoken).toHaveLength(1);
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("does not take an answer that began before the question", () => {
    const { approval, respond, ask } = setup();
    approval.userSpeech();
    ask();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond).not.toHaveBeenCalled();
  });

  it("takes the next answer after a stale one", () => {
    const { approval, respond, ask, say } = setup();
    approval.userSpeech();
    ask();
    approval.heard("yes");
    say("no");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
  });

  it("declines a request for another thread without a question or an outcome", () => {
    const { approval, spoken, outcomes, respond } = setup();
    approval.request(COMMAND, { threadId: "other", command: "ls" }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("declines a request with no thread or before the thread is known", () => {
    const a = setup();
    a.approval.request(COMMAND, { command: "ls" }, a.respond);
    expect(a.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    const b = setup({ threadId: () => null });
    b.approval.request(COMMAND, { threadId: THREAD, command: "ls" }, b.respond);
    expect(b.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(b.spoken).toEqual([]);
  });
});

describe("live Codex approval spoken question limits", () => {
  it("declines at once a command over 120 characters", () => {
    const { spoken, outcomes, respond, ask } = setup();
    ask(`echo ${"x".repeat(116)}`);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([LONG_COMMAND]);
  });

  it("asks about a command of exactly 120 characters", () => {
    const { spoken, respond, ask } = setup();
    ask(`echo ${"x".repeat(115)}`);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken[0]).toContain("Say yes or no.");
  });

  it.each([
    ["a newline", "ls\nrm -rf x"],
    ["a semicolon", "ls; rm -rf x"],
    ["and", "ls && rm -rf x"],
    ["or", "ls || rm -rf x"],
    ["a pipe", "ls | sh"],
    ["a background marker", "sleep 9 &"],
    ["a backtick", "echo `id`"],
    ["a substitution", "echo $(id)"],
  ])("declines at once a command with %s", (_name, command) => {
    const { spoken, outcomes, respond, ask } = setup();
    ask(command);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([LONG_COMMAND]);
  });

  it("declines a command with no text", () => {
    const { spoken, respond, ask } = setup();
    ask("");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([LONG_COMMAND]);
  });

  it("joins a legacy command list into one spoken command", () => {
    const { spoken, approval, respond } = setup();
    approval.request("execCommandApproval", { conversationId: THREAD, command: ["git", "log", "-1"] }, respond);
    expect(spoken).toEqual(["Codex wants to run a command: git log -1. Do you allow it? Say yes or no."]);
  });

  it("always declines a permissions request and never grants it", () => {
    const { approval, spoken, outcomes, respond } = setup();
    approval.request(PERMISSIONS, { threadId: THREAD, permissions: { network: { enabled: true } } }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ permissions: {}, scope: "turn" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual(["Codex asked for more permissions. I declined it. Ask in the chat to allow it."]);
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("names up to three files and asks", () => {
    const { spoken, respond, approval, say } = setup();
    approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges: { "/repo/src/a.ts": {}, "/repo/b.ts": {}, "c.ts": {} } }, respond);
    expect(spoken).toEqual(["Codex wants to change these files: a.ts, b.ts, c.ts. Do you allow it? Say yes or no."]);
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "approved" });
  });

  it("names one file in the singular", () => {
    const { spoken, approval, respond } = setup({ files: () => ["/repo/readme.md"] });
    approval.request(FILES, { threadId: THREAD }, respond);
    expect(spoken).toEqual(["Codex wants to change this file: readme.md. Do you allow it? Say yes or no."]);
  });

  it("declines more than three files with a notice", () => {
    const { spoken, outcomes, approval, respond } = setup();
    approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges: { a: {}, b: {}, c: {}, d: {} } }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain("I declined it");
  });

  it("declines a file change whose files are unknown or whose root is widened", () => {
    const a = setup();
    a.approval.request(FILES, { threadId: THREAD }, a.respond);
    expect(a.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    const b = setup({ files: () => ["x.ts"] });
    b.approval.request(FILES, { threadId: THREAD, grantRoot: "/repo" }, b.respond);
    expect(b.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
  });
});
