import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Workflow } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { draftReducer, type DraftAction } from "@/lib/workflow-canvas";
import { problemText, saveProblems, serverProblems, type ClientProblem } from "@/lib/workflow-graph";
import { ApiError } from "@/state/api";
import { keepDraft, loadWorkflows, takeDraft, useWorkflows, workflowApi, type WorkflowDraft } from "@/state/workflows";

export const SAVE_DELAY_MS = 800;

export type SaveStatus =
  | { state: "saved" }
  | { state: "saving" }
  | { state: "unsaved"; problem: ClientProblem }
  | { state: "refused"; text: string }
  | { state: "changed" }
  | { state: "failed" };

export const fromWorkflow = (workflow: Workflow): WorkflowDraft => ({ name: workflow.name, steps: workflow.steps, connections: workflow.connections });

interface Deps {
  botName: (botId: string) => string | undefined;
  botExists: (botId: string) => boolean;
  onGone: () => void;
}

export function useWorkflowDraft(workflow: Workflow, deps: Deps): {
  draft: WorkflowDraft;
  dispatch: (action: DraftAction) => void;
  status: SaveStatus;
  problems: ClientProblem[];
  retry: () => void;
  reload: () => void;
} {
  const live = useWorkflows();
  const latest = live.workflows.find((candidate) => candidate.id === workflow.id);
  const kept = useRef<WorkflowDraft | null | undefined>(undefined);
  if (kept.current === undefined) kept.current = takeDraft(workflow.id) ?? null;
  const [draft, setDraft] = useState<WorkflowDraft>(() => kept.current ?? fromWorkflow(workflow));
  const [status, setStatus] = useState<SaveStatus>({ state: "saved" });
  const [fromServer, setFromServer] = useState<ClientProblem[]>([]);

  const draftRef = useRef(draft);
  const baseRef = useRef(workflow);
  const dirty = useRef(kept.current !== null);
  const saving = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const latestRef = useRef(latest);
  latestRef.current = latest;

  const stopTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const adopt = useCallback((next: Workflow) => {
    stopTimer();
    const fresh = fromWorkflow(next);
    draftRef.current = fresh;
    baseRef.current = next;
    dirty.current = false;
    again.current = false;
    setDraft(fresh);
    setFromServer([]);
    setStatus({ state: "saved" });
  }, []);

  const fail = useCallback((error: unknown) => {
    const { botName, onGone } = depsRef.current;
    const current = draftRef.current;
    if (error instanceof ApiError) {
      if (error.status === 409 && error.body?.code === "workflow_changed") return setStatus({ state: "changed" });
      if (error.status === 400) {
        const found = serverProblems(error);
        setFromServer(found);
        const reason = problemText(found[0] ?? { code: "workflow_shape" }, current, botName);
        return setStatus({ state: "refused", text: t("workflow.save.refused", { reason }) });
      }
      if (error.status === 403) return setStatus({ state: "refused", text: t("workflow.save.refused", { reason: t("workflow.error.notAllowed") }) });
      if (error.status === 404) {
        if (error.message === "no such bot") return setStatus({ state: "refused", text: t("workflow.save.hiddenBot") });
        return onGone();
      }
    }
    setStatus({ state: "failed" });
  }, []);

  const save = useCallback(async (): Promise<void> => {
    stopTimer();
    if (!dirty.current) return;
    if (saving.current) {
      again.current = true;
      return;
    }
    const problems = saveProblems(draftRef.current, depsRef.current.botExists);
    if (problems.length > 0) {
      setStatus({ state: "unsaved", problem: problems[0]! });
      return;
    }
    const sent = draftRef.current;
    saving.current = true;
    setStatus({ state: "saving" });
    try {
      const saved = await workflowApi.save(workflow.id, { ...sent, ifUpdatedAt: baseRef.current.updatedAt });
      baseRef.current = saved;
      if (draftRef.current === sent) {
        dirty.current = false;
        setFromServer([]);
        setStatus({ state: "saved" });
      } else again.current = true;
    } catch (error) {
      again.current = false;
      fail(error);
    } finally {
      saving.current = false;
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }, [fail, workflow.id]);

  const dispatch = useCallback((action: DraftAction) => {
    const next = draftReducer(draftRef.current, action);
    if (next === draftRef.current) return;
    draftRef.current = next;
    dirty.current = true;
    setDraft(next);
    setFromServer([]);
    stopTimer();
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  useEffect(() => {
    if (kept.current && dirty.current) timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  useEffect(() => {
    if (latest && latest.updatedAt > baseRef.current.updatedAt && !dirty.current && !saving.current) adopt(latest);
  }, [latest, adopt]);

  const gone = live.loaded && !latest;
  useEffect(() => {
    if (gone) depsRef.current.onGone();
  }, [gone]);

  useEffect(() => () => {
    stopTimer();
    if (!dirty.current) return;
    const unsaved = draftRef.current;
    keepDraft(workflow.id, unsaved);
    if (saving.current || saveProblems(unsaved, depsRef.current.botExists).length > 0) return;
    void workflowApi.save(workflow.id, { ...unsaved, ifUpdatedAt: baseRef.current.updatedAt })
      .then(() => { if (draftRef.current === unsaved) takeDraft(workflow.id); })
      .catch(() => {});
  }, [workflow.id]);

  const problems = useMemo(() => [...saveProblems(draft, deps.botExists), ...fromServer], [draft, fromServer, deps.botExists]);

  return {
    draft,
    dispatch,
    status,
    problems,
    retry: () => void save(),
    reload: () => {
      adopt(latestRef.current ?? baseRef.current);
      void loadWorkflows({ background: true });
    },
  };
}
