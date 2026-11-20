import { useCallback, type DragEvent } from "react";
import { GripVertical } from "lucide-react";

import type { Workflow } from "../../../shared/workflows";
import { listOf } from "@/lib/cloud-send";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { botIdsOf, problemText, runnableProblem, startSteps, stepsText } from "@/lib/workflow-graph";
import { useStore } from "@/state/store";
import { useWorkflows } from "@/state/workflows";
import { WorkflowThumb } from "../workflow/WorkflowThumb";
import type { WorkflowBlock } from "./routine-editor-input";

export const WORKFLOW_DRAG_TYPE = "application/x-seira-workflow";

export interface WhatItDoesWorkflow {
  /** null: Instructions. "": Workflow chosen, none picked yet. Otherwise the picked workflow. */
  workflowId: string | null;
  onChange: (workflowId: string | null, startBotId?: string) => void;
  block: WorkflowBlock | null;
  lockedBotId?: string;
  clears: boolean;
}

const BLOCK_TEXT = { room: "workflow.slot.blocked.room", cloud: "workflow.slot.blocked.cloud", limit: "workflow.slot.blocked.limit" } as const;

function startBotOf(workflow: Workflow): string | undefined {
  const start = startSteps(workflow)[0];
  return start?.kind === "bot" ? start.botId : undefined;
}

const reasonId = (workflow: Workflow) => `workflow-use-reason-${workflow.id}`;

export function WorkflowSlot({ workflowId, onChange, block, lockedBotId, clears }: WhatItDoesWorkflow) {
  const { state } = useStore();
  const workflows = useWorkflows();
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const botExists = useCallback((botId: string) => state.bots.some((bot) => bot.id === botId), [state.bots]);
  const chosen = workflowId ? workflows.workflows.find((candidate) => candidate.id === workflowId) : undefined;

  const refusal = (workflow: Workflow): string | null => {
    const problem = runnableProblem(workflow, botExists);
    if (problem) return problemText(problem, workflow, botName);
    const start = startBotOf(workflow);
    if (lockedBotId && start !== lockedBotId) return t("workflow.slot.otherBot", { bot: (start ? botName(start) : undefined) ?? t("workflow.step.noBot") });
    return null;
  };
  const pick = (workflow: Workflow) => {
    if (refusal(workflow)) return;
    onChange(workflow.id, startBotOf(workflow));
  };
  const accepts = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes(WORKFLOW_DRAG_TYPE);
  const dropped = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    const dropId = event.dataTransfer.getData(WORKFLOW_DRAG_TYPE);
    const workflow = workflows.workflows.find((candidate) => candidate.id === dropId);
    if (workflow) pick(workflow);
  };
  const botsOf = (workflow: Workflow) => botIdsOf(workflow).flatMap((id) => botName(id) ?? []);
  const summary = (workflow: Workflow) => [stepsText(workflow.steps.filter((step) => step.kind !== "note").length), botsOf(workflow).length ? listOf(botsOf(workflow)) : ""].filter(Boolean).join(" · ");

  return (
    <div className="space-y-3">
      {block && <p className="text-[13px] leading-[18px] text-warning">{t(BLOCK_TEXT[block])}</p>}
      {clears && <p className="text-[13px] leading-[18px] text-ink-secondary">{t("workflow.slot.clears")}</p>}
      <div data-workflow-slot onDragOver={(event) => { if (accepts(event)) event.preventDefault(); }} onDrop={dropped}>
        {chosen ? (
          <div className="flex items-center gap-3 rounded-xl border border-hairline/50 bg-card p-2.5">
            <WorkflowThumb graph={chosen} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink" dir="auto">{chosen.name}</p>
              <p className="text-[12px] text-ink-secondary">{summary(chosen)}</p>
            </div>
            <button type="button" aria-label={t("workflow.slot.removeNamed", { name: chosen.name })} onClick={() => onChange("")}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">{t("workflow.slot.remove")}</button>
          </div>
        ) : workflowId && workflows.loaded ? (
          <p role="status" className="rounded-xl border border-dashed border-warning/50 p-3 text-[13px] text-warning">{t("workflow.slot.missing")}</p>
        ) : (
          <p className="rounded-xl border border-dashed border-hairline/60 p-3 text-center text-[13px] text-ink-secondary">{t("workflow.slot.drop")}</p>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{t("workflow.slot.yours")}</p>
        {workflows.workflows.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">{t("workflow.slot.none")}</p>
        ) : (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto">
            {workflows.workflows.map((workflow) => {
              const why = refusal(workflow);
              const inUse = workflow.id === workflowId;
              return (
                <li key={workflow.id} data-workflow-card={workflow.id} draggable onDragStart={(event) => { event.dataTransfer.setData(WORKFLOW_DRAG_TYPE, workflow.id); }}
                  className="rounded-xl border border-hairline/40 bg-card px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <GripVertical size={14} aria-hidden className="shrink-0 text-ink-tertiary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink" dir="auto">{workflow.name}</p>
                      <p className="text-[12px] text-ink-secondary">{summary(workflow)}</p>
                    </div>
                    {inUse ? <span className="shrink-0 text-[12px] text-ink-secondary">{t("workflow.slot.inUse")}</span> : (
                      <button type="button" aria-disabled={Boolean(why) || undefined} aria-describedby={why ? reasonId(workflow) : undefined} aria-label={t("workflow.slot.useNamed", { name: workflow.name })} onClick={() => pick(workflow)}
                        className={cn("shrink-0 rounded-lg border border-hairline/50 px-2.5 py-1 text-[13px] text-ink hover:bg-raised", why && "cursor-not-allowed opacity-50")}>{t("workflow.slot.use")}</button>
                    )}
                  </div>
                  {why && !inUse && <p id={reasonId(workflow)} className="mt-1 pl-6 text-[12px] leading-4 text-ink-secondary">{why}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
