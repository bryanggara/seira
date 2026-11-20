import { describe, expect, it } from "vitest";

import type { Workflow } from "../../shared/workflows.ts";
import { linkWorkflow, workflowCopy, workflowPromptCopy } from "./routine-link.ts";

const names: Record<string, string> = { ana: "Ana", ben: "Ben" };
const botName = (id: string) => names[id];
const at = { x: 0, y: 0 };

const flow = (over: Partial<Workflow> = {}): Workflow => ({
  id: "w1", name: "Morning", createdAt: 1, updatedAt: 1,
  steps: [
    { id: "a", kind: "bot", botId: "ana", instruction: "Collect the news", position: at },
    { id: "c", kind: "check", question: "Is there news?", position: at },
    { id: "b", kind: "bot", botId: "ben", instruction: "Write the digest", position: at },
    { id: "w", kind: "wait", minutes: 1, position: at },
    { id: "p", kind: "post", position: at },
    { id: "n", kind: "note", text: "memo", position: at },
  ],
  connections: [
    { id: "1", from: "a", to: "c" }, { id: "2", from: "c", to: "b", branch: "yes" }, { id: "3", from: "c", to: "w", branch: "no" },
    { id: "4", from: "b", to: "p" }, { id: "5", from: "w", to: "p" },
  ],
  ...over,
});

describe("the prompt copy of a workflow", () => {
  it("lists the steps in order, with the branch targets of a check", () => {
    expect(workflowPromptCopy(flow(), botName)).toBe([
      'This routine runs the workflow "Morning". Do these steps in order:',
      "1. Ana: Collect the news",
      "2. AI check: Is there news? If yes, go to 3. If no, go to 4.",
      "3. Ben: Write the digest Then go to 5.",
      "4. Wait 1 minute.",
      "5. Post results.",
    ].join("\n"));
  });

  it("leaves a note out", () => {
    expect(workflowPromptCopy(flow(), botName)).not.toContain("memo");
  });

  it("says a check with no branch finishes", () => {
    const copy = workflowPromptCopy(flow({ connections: [{ id: "1", from: "a", to: "c" }] }), botName);
    expect(copy).toContain("If yes, finish. If no, finish.");
  });

  it("says when a workflow has no steps", () => {
    expect(workflowPromptCopy(flow({ steps: [], connections: [] }), botName)).toBe('This routine runs the workflow "Morning". It has no steps yet.');
  });

  it("clips a long instruction and the whole copy", () => {
    const long = flow({ steps: [{ id: "a", kind: "bot", botId: "ana", instruction: "x".repeat(5_000), position: at }], connections: [] });
    expect(workflowPromptCopy(long, botName).length).toBeLessThan(2_200);
    const many = flow({
      steps: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, kind: "bot" as const, botId: "ana", instruction: "y".repeat(1_900), position: at })),
      connections: Array.from({ length: 49 }, (_, i) => ({ id: `k${i}`, from: `s${i}`, to: `s${i + 1}` })),
    });
    expect(workflowPromptCopy(many, botName).length).toBeLessThanOrEqual(20_000);
  });
});

describe("the routine fields a workflow sets", () => {
  it("takes the first bot as the routine's bot, and lists every bot once", () => {
    expect(workflowCopy(flow(), botName)).toEqual({ workflowId: "w1", prompt: workflowPromptCopy(flow(), botName), botId: "ana", botIds: ["ana", "ben"] });
  });
});

describe("linking a routine to a workflow", () => {
  const copy = workflowCopy(flow(), botName);

  it("sets nothing when the input names no workflow", () => {
    expect(linkWorkflow({}, undefined)).toBeNull();
    expect(linkWorkflow({ workflowId: null }, () => copy)).toBeNull();
  });

  it("returns the copy of a workflow that exists", () => {
    expect(linkWorkflow({ workflowId: "w1" }, () => copy)).toBe(copy);
  });

  it("refuses a workflow that is gone, or when workflows are unavailable", () => {
    expect(() => linkWorkflow({ workflowId: "w9" }, () => null)).toThrow("That workflow is gone. Choose another one.");
    expect(() => linkWorkflow({ workflowId: "w9" }, undefined)).toThrow("That workflow is gone. Choose another one.");
  });

  it("refuses a workflow that cannot run yet, with the problem's own words", () => {
    expect(() => linkWorkflow({ workflowId: "w1" }, () => ({ code: "workflow_no_start", message: "Add a bot step to start this workflow." }))).toThrow("Add a bot step to start this workflow.");
  });
});
