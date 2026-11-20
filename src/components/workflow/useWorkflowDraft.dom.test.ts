// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow } from "../../../shared/workflows";
import { ApiError } from "@/state/api";
import { applyWorkflowFrame, resetWorkflowsForTest } from "@/state/workflows";

const fixture = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));

const { SAVE_DELAY_MS, useWorkflowDraft } = await import("./useWorkflowDraft");
type Hook = ReturnType<typeof useWorkflowDraft>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flow: Workflow = {
  id: "wf1", name: "Morning", createdAt: 1, updatedAt: 10, connections: [],
  steps: [{ id: "a", kind: "bot", botId: "bot-a", instruction: "Do it", position: { x: 0, y: 0 } }],
};
const botExists = (id: string) => id === "bot-a";
const botName = (id: string) => (id === "bot-a" ? "Scout" : undefined);

let root: Root | null = null;
let hook: { current: Hook };
let onGone: () => void;

function mount(workflow: Workflow = flow) {
  hook = { current: null as unknown as Hook };
  function Probe() {
    hook.current = useWorkflowDraft(workflow, { botName, botExists, onGone });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Probe)));
}
const unmount = () => { act(() => root?.unmount()); root = null; };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const rename = (name: string) => act(() => hook.current.dispatch({ type: "rename", name }));
const patches = () => fixture.api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PATCH");
const sentBody = (index: number) => JSON.parse((patches()[index]![1] as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  onGone = vi.fn<() => void>();
  resetWorkflowsForTest();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
    const method = (init as { method?: string } | undefined)?.method;
    if (path === "/api/workflows" && !method) return { workflows: [flow] };
    if (method === "PATCH") {
      const body = JSON.parse((init as { body: string }).body) as Partial<Workflow>;
      return { workflow: { ...flow, ...body, updatedAt: Date.now() } };
    }
    return {};
  });
});
afterEach(() => {
  if (root) unmount();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useWorkflowDraft", () => {
  it("saves 800 ms after the last change with ifUpdatedAt, one save at a time", async () => {
    mount();
    await advance(0);
    rename("One");
    await advance(SAVE_DELAY_MS - 1);
    rename("Two");
    await advance(SAVE_DELAY_MS - 1);
    expect(patches()).toHaveLength(0);
    let release: (value: unknown) => void = () => {};
    fixture.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await advance(1);
    expect(patches()).toHaveLength(1);
    expect(sentBody(0)).toMatchObject({ name: "Two", ifUpdatedAt: 10 });
    expect(hook.current.status).toEqual({ state: "saving" });
    rename("Three");
    await advance(SAVE_DELAY_MS);
    expect(patches()).toHaveLength(1);
    await act(async () => { release({ workflow: { ...flow, name: "Two", updatedAt: 20 } }); });
    await advance(0);
    expect(patches()).toHaveLength(2);
    expect(sentBody(1)).toMatchObject({ name: "Three", ifUpdatedAt: 20 });
  });

  it("holds the save while a client check finds a problem, and says why", async () => {
    mount();
    await advance(0);
    rename("   ");
    await advance(SAVE_DELAY_MS);
    expect(patches()).toHaveLength(0);
    expect(hook.current.status).toMatchObject({ state: "unsaved", problem: { code: "workflow_name" } });
    expect(hook.current.problems.map((problem) => problem.code)).toContain("workflow_name");
    rename("Fixed");
    await advance(SAVE_DELAY_MS);
    expect(patches()).toHaveLength(1);
  });

  it("puts a server problem on its step", async () => {
    mount();
    await advance(0);
    fixture.api.mockImplementationOnce(async () => {
      throw new ApiError("bad", 400, { problems: [{ code: "workflow_instruction_missing", stepId: "a" }] });
    });
    rename("Next");
    await advance(SAVE_DELAY_MS);
    expect(hook.current.problems).toContainEqual({ code: "workflow_instruction_missing", stepId: "a" });
    expect(hook.current.status).toMatchObject({ state: "refused" });
    expect((hook.current.status as { text: string }).text).toContain("Couldn't save.");
  });

  it("shows the conflict text and Reload after a 409, and Reload takes the saved workflow", async () => {
    mount();
    await advance(0);
    const newer = { ...flow, name: "From elsewhere", updatedAt: 50 };
    fixture.api.mockImplementationOnce(async () => { throw new ApiError("conflict", 409, { code: "workflow_changed" }); });
    rename("Mine");
    await advance(SAVE_DELAY_MS);
    expect(hook.current.status).toEqual({ state: "changed" });
    act(() => applyWorkflowFrame({ kind: "workflow", workflow: newer }));
    expect(hook.current.draft.name).toBe("Mine");
    act(() => hook.current.reload());
    await advance(0);
    expect(hook.current.draft.name).toBe("From elsewhere");
    expect(hook.current.status).toEqual({ state: "saved" });
  });

  it("shows Couldn't save and Try again after a network error, and Try again saves", async () => {
    mount();
    await advance(0);
    fixture.api.mockImplementationOnce(async () => { throw new ApiError("offline", 0); });
    rename("Mine");
    await advance(SAVE_DELAY_MS);
    expect(hook.current.status).toEqual({ state: "failed" });
    act(() => hook.current.retry());
    await advance(0);
    expect(patches()).toHaveLength(2);
    expect(hook.current.status).toEqual({ state: "saved" });
  });

  it("takes a newer workflow from another window only when nothing is unsaved", async () => {
    mount();
    await advance(0);
    act(() => applyWorkflowFrame({ kind: "workflow", workflow: { ...flow, name: "Elsewhere", updatedAt: 30 } }));
    expect(hook.current.draft.name).toBe("Elsewhere");
    rename("Mine");
    act(() => applyWorkflowFrame({ kind: "workflow", workflow: { ...flow, name: "Again elsewhere", updatedAt: 40 } }));
    expect(hook.current.draft.name).toBe("Mine");
  });

  it("keeps an unsaved draft when the editor closes and gives it back when it opens again", async () => {
    mount();
    await advance(0);
    fixture.api.mockImplementation(async () => { throw new ApiError("offline", 0); });
    rename("Half done");
    unmount();
    await advance(0);
    mount();
    await advance(0);
    expect(hook.current.draft.name).toBe("Half done");
  });

  it("goes back to the list when the workflow is deleted", async () => {
    mount();
    await advance(0);
    expect(onGone).not.toHaveBeenCalled();
    act(() => applyWorkflowFrame({ kind: "workflow.deleted", workflowId: "wf1" }));
    expect(onGone).toHaveBeenCalled();
  });
});
