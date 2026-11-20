import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Workflow as WorkflowIcon } from "lucide-react";

import type { WorkflowRun } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { routineDateTime } from "@/lib/routine-display";
import { useShowThreads } from "@/lib/thread-preferences";
import { stepById, stepTitle } from "@/lib/workflow-graph";
import { activeRun, runStatusText, stepViews } from "@/lib/workflow-run";
import { ApiError } from "@/state/api";
import { useStore } from "@/state/store";
import { openThread } from "@/state/thread-navigation";
import { loadWorkflowRun, loadWorkflowRuns, runsOf, useWorkflows, workflowApi } from "@/state/workflows";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowRunPanel, type AgainState } from "./WorkflowRunPanel";

type Load = "loading" | "gone" | "failed" | "ready";

function firstSelected(run: WorkflowRun): string | null {
  const views = stepViews(run);
  const failed = run.graph.steps.find((step) => views[step.id]?.state === "failed");
  if (failed) return failed.id;
  if (run.currentStepId && stepById(run.graph, run.currentStepId)) return run.currentStepId;
  return stepById(run.graph, run.startStepId) ? run.startStepId : null;
}

function againErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t("workflow.save.failed");
  if (error.status === 403) return t("workflow.error.notAllowed");
  if (error.status === 404) return t("workflow.run.gone");
  if (error.status === 409) return t("workflow.run.againConflict");
  return t("workflow.save.failed");
}

export function WorkflowRunView({ workflowId, runId }: { workflowId: string; runId: string }) {
  const { state, dispatch } = useStore();
  const workflows = useWorkflows();
  const advanced = useAdvancedMode();
  const showThreads = useShowThreads();
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [againError, setAgainError] = useState("");
  const chosen = useRef(false);
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const run = workflows.details[runId];

  useEffect(() => {
    let current = true;
    setLoad("loading");
    loadWorkflowRun(runId, { force: attempt > 0 }).then(
      (loaded) => { if (current) setLoad(loaded ? "ready" : "gone"); },
      () => { if (current) setLoad("failed"); },
    );
    return () => { current = false; };
  }, [runId, attempt]);
  useEffect(() => { void loadWorkflowRuns(workflowId); }, [workflowId]);
  useEffect(() => {
    if (!run || chosen.current) return;
    chosen.current = true;
    setSelectedId(firstSelected(run));
  }, [run]);

  const open = useCallback((id?: string) => dispatch({ type: "showRoutines", view: "workflows", workflowId: id }), [dispatch]);
  const views = useMemo(() => (run ? stepViews(run) : {}), [run]);
  const step = run && selectedId ? stepById(run.graph, selectedId) ?? null : null;
  const view = step ? views[step.id] : undefined;

  const again = ((): AgainState => {
    if (!run || !step || view?.state !== "failed" || run.status === "active") return { state: "hidden" };
    const routine = state.routines.find((candidate) => candidate.id === run.routineId);
    if (!routine) return { state: "hidden" };
    if (routine.workflowId !== run.workflowId) return { state: "other" };
    const current = workflows.workflows.find((candidate) => candidate.id === run.workflowId);
    if (!current?.steps.some((candidate) => candidate.id === step.id)) return { state: "hidden" };
    return activeRun(state.routineRuns, routine.id) ? { state: "busy" } : { state: "show" };
  })();

  const runAgain = async (stepId: string) => {
    if (!run) return;
    setAgainError("");
    try {
      const started = await workflowApi.runAgain(run.runId, stepId);
      const target = stepById(run.graph, stepId);
      setAnnouncement(t("workflow.run.againStarted", { step: target ? stepTitle(target, botName) : "" }));
      dispatch({ type: "showRoutines", view: "workflows", workflowId: run.workflowId, workflowRunId: started.id });
    } catch (error) {
      setAgainError(againErrorText(error));
    }
  };

  if (load === "gone" || (load === "ready" && !run)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p role="status" className="text-[13px] text-ink-secondary">{t("workflow.run.gone")}</p>
        <button type="button" onClick={() => open()} className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110">{t("workflow.all")}</button>
      </div>
    );
  }
  if (load === "failed" && !run) {
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] text-ink-secondary">{t("workflow.run.loadFailed")}</p>
        <button type="button" onClick={() => setAttempt((count) => count + 1)} className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110">{t("common.tryAgain")}</button>
      </div>
    );
  }
  if (!run) return <div className="flex-1" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline/35 px-4 py-2.5">
        <button type="button" onClick={() => open()} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus">
          <ArrowLeft size={15} aria-hidden />{t("workflow.all")}
        </button>
        <WorkflowIcon size={16} aria-hidden className="shrink-0 text-ink-tertiary" />
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink" dir="auto">{run.workflowName}</h2>
        <span className="text-[12px] text-ink-secondary">{t("workflow.run.started", { when: routineDateTime(run.createdAt) })}</span>
        <p role="status" data-workflow-run-status={run.status} className="min-w-0 flex-1 text-[13px] text-ink-secondary">{runStatusText(run, run.graph, botName)}</p>
        <button type="button" onClick={() => open(run.workflowId)} className="h-8 rounded-lg border border-hairline/50 px-3 text-[13px] text-ink hover:bg-raised">{t("workflow.run.edit")}</button>
      </div>
      {againError && <p role="alert" className="shrink-0 px-4 pt-2 text-[13px] text-danger">{againError}</p>}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative flex min-h-[320px] min-w-0 flex-1 flex-col">
          <WorkflowCanvas graph={run.graph} botName={botName} selectedId={selectedId} onSelect={setSelectedId} label={t("workflow.region")} statuses={views} />
        </div>
        <WorkflowRunPanel run={run} step={step} view={view} botName={botName} advanced={advanced} again={again} onRunAgain={runAgain}
          onOpenChat={(botId, threadId) => { openThread(dispatch, { botId, threadId }, state, showThreads); }}
          runs={runsOf(workflows, run.workflowId, run.routineId)} onOpenRun={(id) => dispatch({ type: "showRoutines", view: "workflows", workflowId: run.workflowId, workflowRunId: id })} />
      </div>
      <p role="status" className="sr-only">{announcement}</p>
    </div>
  );
}
