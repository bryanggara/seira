// Workflows on the client: one shared copy of /api/workflows and of the runs, kept current by the workflow live frames,
// for the Workflows view, the routine editor and the run cards.
import { useEffect, useSyncExternalStore } from "react";

import type { Workflow, WorkflowGraph, WorkflowInput, WorkflowRun, WorkflowRunUpdate, WorkflowStepRun } from "../../shared/workflows";
import type { ServerFrame } from "../../shared/wire";
import { listenLiveFrames } from "@/lib/live-events";
import type { RoutineRun } from "@/lib/routines";
import { api, ApiError } from "@/state/store";

export interface WorkflowsState {
  loaded: boolean;
  /** The list answered 404 or 503: the Workflows view and the routine slot stay hidden. */
  unavailable: boolean;
  /** The last list load failed on the network. */
  failed: boolean;
  workflows: Workflow[];
  /** Run updates by routine run id, from frames and run lists. */
  runs: Record<string, WorkflowRunUpdate>;
  /** Full runs with their graph, by routine run id. */
  details: Record<string, WorkflowRun>;
}
export type WorkflowDraft = WorkflowGraph & { name: string };

const EMPTY: WorkflowsState = { loaded: false, unavailable: false, failed: false, workflows: [], runs: {}, details: {} };
const MAX_RUNS = 200;
const MAX_DETAILS = 20;
const RUNS_LIMIT = 20;

let state = EMPTY;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;
let started = false;
let loading: Promise<void> | null = null;
const runLoads = new Map<string, Promise<WorkflowRun | null>>();
const drafts = new Map<string, WorkflowDraft>();

function set(next: WorkflowsState): void {
  state = next;
  for (const listener of listeners) listener();
}

const withoutGraph = ({ graph: _graph, ...update }: WorkflowRun): WorkflowRunUpdate => update;

function newest<T extends { updatedAt: number }>(record: Record<string, T>, keep: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= keep) return record;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, keep));
}

/** A frame carries a clipped copy of a long output: keep the full one the run already has for the same finished step. */
function mergeStepRuns(old: readonly WorkflowStepRun[], next: readonly WorkflowStepRun[]): WorkflowStepRun[] {
  return next.map((stepRun) => {
    if (!stepRun.outputClipped) return stepRun;
    const earlier = old.find((candidate) => candidate.stepId === stepRun.stepId);
    if (!earlier || earlier.outputClipped || earlier.output === undefined || earlier.finishedAt !== stepRun.finishedAt) return stepRun;
    const { outputClipped: _clipped, ...rest } = stepRun;
    return { ...rest, output: earlier.output };
  });
}

function putRun(run: WorkflowRunUpdate): void {
  const known = state.runs[run.runId];
  if (known && known.updatedAt > run.updatedAt) return;
  const detail = state.details[run.runId];
  set({
    ...state,
    runs: newest({ ...state.runs, [run.runId]: run }, MAX_RUNS),
    details: detail ? { ...state.details, [run.runId]: { ...detail, ...run, graph: detail.graph, stepRuns: mergeStepRuns(detail.stepRuns, run.stepRuns) } } : state.details,
  });
}

export function applyWorkflowFrame(frame: ServerFrame): void {
  if (frame.kind === "workflow") {
    const incoming = frame.workflow;
    const known = state.workflows.find((workflow) => workflow.id === incoming.id);
    if (!known) set({ ...state, workflows: [incoming, ...state.workflows] });
    else if (incoming.updatedAt >= known.updatedAt) set({ ...state, workflows: state.workflows.map((workflow) => workflow.id === incoming.id ? incoming : workflow) });
  } else if (frame.kind === "workflow.deleted") {
    drafts.delete(frame.workflowId);
    set({ ...state, workflows: state.workflows.filter((workflow) => workflow.id !== frame.workflowId) });
  } else if (frame.kind === "workflow.run") {
    putRun(frame.run);
  }
}

const unreachable = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 503) && error.body?.error !== "asleep";

export function loadWorkflows(options: { background?: boolean } = {}): Promise<void> {
  loading ??= api<{ workflows?: Workflow[] }>("/api/workflows", options.background ? { background: true } : undefined)
    .then((body) => set({ ...state, loaded: true, unavailable: false, failed: false, workflows: body.workflows ?? [] }))
    .catch((error: unknown) => set(unreachable(error)
      ? { ...state, loaded: true, unavailable: true, failed: false }
      : { ...state, loaded: true, failed: true }))
    .finally(() => { loading = null; });
  return loading;
}

export async function loadWorkflowRuns(workflowId: string, limit = RUNS_LIMIT): Promise<void> {
  try {
    const body = await api<{ runs?: WorkflowRunUpdate[] }>(`/api/workflows/${encodeURIComponent(workflowId)}/runs?limit=${limit}`);
    for (const run of body.runs ?? []) putRun(run);
  } catch {
    // The runs already shown stay; the next frame or visit loads them again.
  }
}

export function loadWorkflowRun(runId: string, options: { force?: boolean } = {}): Promise<WorkflowRun | null> {
  const known = state.details[runId];
  if (known && !options.force) return Promise.resolve(known);
  const pending = runLoads.get(runId);
  if (pending && !options.force) return pending;
  const load: Promise<WorkflowRun | null> = api<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(runId)}`)
    .then(({ run }) => {
      set({
        ...state,
        runs: newest({ ...state.runs, [run.runId]: withoutGraph(run) }, MAX_RUNS),
        details: newest({ ...state.details, [run.runId]: run }, MAX_DETAILS),
      });
      return run;
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    })
    .finally(() => { if (runLoads.get(runId) === load) runLoads.delete(runId); });
  runLoads.set(runId, load);
  return load;
}

function start(): void {
  if (started) return;
  started = true;
  stopListening = listenLiveFrames({ onFrame: applyWorkflowFrame, onMissedFrames: () => void loadWorkflows({ background: true }) });
  void loadWorkflows();
}

export function useWorkflows(): WorkflowsState {
  useEffect(start, []);
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state, () => EMPTY);
}

const time = (run: WorkflowRunUpdate) => run.createdAt;

/** Newest first. */
export function runsOf(snapshot: WorkflowsState, workflowId: string, routineId?: string): WorkflowRunUpdate[] {
  return Object.values(snapshot.runs)
    .filter((run) => run.workflowId === workflowId && (routineId === undefined || run.routineId === routineId))
    .sort((a, b) => time(b) - time(a) || b.updatedAt - a.updatedAt);
}

const put = (workflow: Workflow) => applyWorkflowFrame({ kind: "workflow", workflow });

export const workflowApi = {
  async create(input: WorkflowInput): Promise<Workflow> {
    const { workflow } = await api<{ workflow: Workflow }>("/api/workflows", { method: "POST", body: JSON.stringify(input) });
    put(workflow);
    return workflow;
  },
  async save(id: string, input: WorkflowInput): Promise<Workflow> {
    const body = { name: input.name, steps: input.steps, connections: input.connections, ifUpdatedAt: input.ifUpdatedAt };
    const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
    put(workflow);
    return workflow;
  },
  async remove(id: string): Promise<void> {
    await api(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
    applyWorkflowFrame({ kind: "workflow.deleted", workflowId: id });
  },
  async runAgain(runId: string, stepId: string): Promise<RoutineRun> {
    const { run } = await api<{ run: RoutineRun }>(
      `/api/workflow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/run-again`,
      { method: "POST" },
    );
    return run;
  },
};

export function keepDraft(workflowId: string, draft: WorkflowDraft): void {
  drafts.set(workflowId, draft);
}

export function takeDraft(workflowId: string): WorkflowDraft | undefined {
  const draft = drafts.get(workflowId);
  drafts.delete(workflowId);
  return draft;
}

export function resetWorkflowsForTest(): void {
  stopListening?.();
  stopListening = null;
  started = false;
  loading = null;
  runLoads.clear();
  drafts.clear();
  state = EMPTY;
  listeners.clear();
}
