import type { Workflow, WorkflowInput, WorkflowRun, WorkflowRunUpdate } from "../../shared/workflows.ts";
import { routineVisible, workflowRunVisible, workflowVisible, type VisibleSet } from "../bot-visibility.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import { problemBody, validateWorkflowInput } from "../workflows/validate.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WorkflowRoutesDeps {
  visible(auth: RequestAuth): VisibleSet;
  botName(botId: string): string | undefined;
  workflows(): WorkflowHost | null;
  routines(): Pick<RoutineManager, "listRoutines"> | null;
}

const RUNS_DEFAULT = 20;
const RUNS_MAX = 50;

const withoutGraph = ({ graph: _graph, ...update }: WorkflowRun): WorkflowRunUpdate => update;

function hiddenBot(steps: unknown, visible: VisibleSet, botName: (botId: string) => string | undefined): boolean {
  if (visible.everything || !Array.isArray(steps)) return false;
  return steps.some((step) => {
    const botId = (step as { kind?: unknown; botId?: unknown } | null)?.kind === "bot" ? (step as { botId?: unknown }).botId : undefined;
    return typeof botId === "string" && botName(botId) !== undefined && !visible.bot(botId);
  });
}

/** For the routine save check: a workflow the person may not see is "no such workflow". */
export function workflowTargetHidden(body: unknown, visible: VisibleSet, workflows: WorkflowHost | null): string | null {
  if (visible.everything || !body || typeof body !== "object") return null;
  const { workflowId } = body as { workflowId?: unknown };
  const workflow = typeof workflowId === "string" ? workflows?.get(workflowId) : null;
  return workflow && !workflowVisible(workflow, visible) ? "no such workflow" : null;
}

export function createWorkflowRoutes(deps: WorkflowRoutesDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const again = /^\/api\/workflow-runs\/([\w-]+)\/steps\/([\w-]+)\/run-again$/.exec(path);
    const runMatch = /^\/api\/workflow-runs\/([\w-]+)$/.exec(path);
    const runsMatch = /^\/api\/workflows\/([\w-]+)\/runs$/.exec(path);
    const oneMatch = /^\/api\/workflows\/([\w-]+)$/.exec(path);
    if (path !== "/api/workflows" && !again && !runMatch && !runsMatch && !oneMatch) return PASS;
    const host = deps.workflows();
    if (!host) return json(res, 503, { error: "Workflows are unavailable." });
    const visible = deps.visible(auth);
    const shown = (id: string): Workflow | null => {
      const workflow = host.get(id);
      return workflow && workflowVisible(workflow, visible) ? workflow : null;
    };

    const save = (body: unknown, current: Workflow | null, write: (input: WorkflowInput) => Workflow | null, status: number) => {
      const checked = validateWorkflowInput(body, { botName: deps.botName });
      if (!checked.ok) return json(res, 400, problemBody(checked.problems));
      if (hiddenBot(checked.value.steps, visible, deps.botName)) return json(res, 404, { error: "no such bot" });
      if (current && checked.value.ifUpdatedAt !== undefined && checked.value.ifUpdatedAt < current.updatedAt) {
        return json(res, 409, { error: "This workflow was changed somewhere else. Reload it and try again.", code: "workflow_changed" });
      }
      const saved = write(checked.value);
      return saved ? json(res, status, { workflow: saved }) : json(res, 404, { error: "no such workflow" });
    };

    if (path === "/api/workflows") {
      if (method === "GET") return json(res, 200, { workflows: host.list().filter((workflow) => workflowVisible(workflow, visible)) });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      return save(await readBody(req), null, (input) => host.create(input), 201);
    }

    if (oneMatch) {
      const workflow = shown(oneMatch[1]!);
      if (!workflow) return json(res, 404, { error: "no such workflow" });
      if (method === "GET") return json(res, 200, { workflow });
      if (method === "DELETE") return host.remove(workflow.id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such workflow" });
      if (method !== "PATCH") return json(res, 405, { error: "method not allowed" });
      return save(await readBody(req), workflow, (input) => host.update(workflow.id, input), 200);
    }

    if (runsMatch) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const workflow = shown(runsMatch[1]!);
      if (!workflow) return json(res, 404, { error: "no such workflow" });
      const asked = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(asked) ? Math.min(RUNS_MAX, Math.max(1, asked)) : RUNS_DEFAULT;
      return json(res, 200, { runs: host.runs(workflow.id, limit).filter((run) => workflowRunVisible(run, visible)).map(withoutGraph) });
    }

    if (runMatch) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const run = host.run(runMatch[1]!);
      return run && workflowRunVisible(run, visible) ? json(res, 200, { run }) : json(res, 404, { error: "no such run" });
    }

    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const [, runId, stepId] = again!;
    const old = host.run(runId!);
    if (!old || !workflowRunVisible(old, visible)) return json(res, 404, { error: "no such run" });
    if (old.status === "active") return json(res, 409, { error: "This run is still going." });
    const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === old.routineId);
    if (!routine || !routineVisible(routine, visible)) return json(res, 404, { error: "no such routine" });
    if (routine.workflowId !== old.workflowId) return json(res, 409, { error: "This routine now runs another workflow." });
    const workflow = shown(old.workflowId);
    if (!workflow) return json(res, 404, { error: "no such workflow" });
    if (old.stepRuns.find((step) => step.stepId === stepId)?.status !== "failed") return json(res, 409, { error: "Only a failed step can run again." });
    const step = workflow.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind === "note") return json(res, 409, { error: "That step is no longer in the workflow." });
    try {
      const started = host.runAgain(old.runId, stepId!, routine, workflow);
      return started ? json(res, 201, { run: started }) : json(res, 409, { error: "The routine can't run now." });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : "The run could not start." });
    }
  };
}
