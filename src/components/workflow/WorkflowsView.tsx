import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import type { Workflow } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { loadWorkflows, useWorkflows, workflowApi } from "@/state/workflows";
import { UndoToast } from "../bot-access/ShareBotButton";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowList } from "./WorkflowList";

const SPINNER_DELAY_MS = 300;

function useDelayed(active: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return setLate(false);
    const timer = window.setTimeout(() => setLate(true), SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return active && late;
}

export function WorkflowsView({ workflowId, onUseInRoutine }: { workflowId?: string; workflowRunId?: string; onUseInRoutine?: (workflow: Workflow) => void }) {
  const { state, dispatch } = useStore();
  const workflows = useWorkflows();
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [vanished, setVanished] = useState(false);
  const [deleted, setDeleted] = useState<{ workflow: Workflow; key: number } | null>(null);
  const leaving = useRef<string | null>(null);
  const deletedKey = useRef(0);
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const workflow = workflowId ? workflows.workflows.find((candidate) => candidate.id === workflowId) : undefined;
  const loading = !workflows.loaded;
  const showSpinner = useDelayed(loading);

  const open = useCallback((id?: string) => dispatch({ type: "showRoutines", view: "workflows", workflowId: id }), [dispatch]);
  const created = async () => {
    if (creating) return;
    setCreating(true);
    setCreateFailed(false);
    try {
      const made = await workflowApi.create({ name: t("workflow.untitled"), steps: [], connections: [] });
      setVanished(false);
      open(made.id);
    } catch {
      setCreateFailed(true);
    } finally {
      setCreating(false);
    }
  };
  const onGone = useCallback(() => {
    setVanished(true);
    open();
  }, [open]);
  const onDelete = useCallback(async (removed: Workflow) => {
    leaving.current = removed.id;
    try {
      await workflowApi.remove(removed.id);
    } catch (error) {
      leaving.current = null;
      throw error;
    }
    open();
    setDeleted({ workflow: removed, key: ++deletedKey.current });
  }, [open]);
  const deletedDone = useCallback(() => setDeleted(null), []);
  const undoDelete = useCallback(async () => {
    if (!deleted) return;
    const { name, steps, connections } = deleted.workflow;
    await workflowApi.create({ name, steps, connections });
  }, [deleted]);

  let body;
  if (workflow) {
    body = (
      <WorkflowEditor key={workflow.id} workflow={workflow} usedBy={state.routines.filter((routine) => routine.workflowId === workflow.id)}
        onBack={() => { setVanished(false); open(); }} onGone={onGone} onDelete={onDelete} onUseInRoutine={onUseInRoutine} />
    );
  } else if (loading) {
    body = <div className="flex flex-1 items-center justify-center">{showSpinner && <Loader2 size={20} aria-hidden className="animate-spin text-ink-tertiary motion-reduce:animate-none" />}</div>;
  } else if (workflows.failed && workflows.workflows.length === 0) {
    body = (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] text-ink-secondary">{t("workflow.loadFailed")}</p>
        <button type="button" onClick={() => void loadWorkflows()} className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110">{t("common.tryAgain")}</button>
      </div>
    );
  } else {
    const gone = vanished || (Boolean(workflowId) && leaving.current !== workflowId);
    body = <WorkflowList workflows={workflows.workflows} routines={state.routines} botName={botName} gone={gone} onOpen={(id) => { setVanished(false); open(id); }} onNew={() => void created()} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {createFailed && <p role="alert" className="shrink-0 px-4 pt-3 text-[13px] text-danger">{t("workflow.save.failed")}</p>}
      {body}
      {deleted && <UndoToast key={deleted.key} text={t("workflow.deleted", { name: deleted.workflow.name })} onUndo={undoDelete} onDone={deletedDone} />}
    </div>
  );
}
