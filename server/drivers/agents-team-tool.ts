// The Chief's suggest_team tool and its internal route. It shows a card in the chat and creates nothing.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set(["suggest_team"]);

export const TEAM_TOOL_DEFINITIONS = [
  {
    name: "suggest_team",
    description:
      "Chief of Staff only: show the person a suggested team for their work as a card in this chat. It creates nothing: they rename, untick, create or skip it. Call once, then end your turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        department: { type: "string", maxLength: 60, description: "Short name of the team." },
        summary: { type: "string", maxLength: 2000, description: "One or two sentences on what the team does for this person." },
        bots: {
          type: "array", minItems: 1, maxItems: 8,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string", maxLength: 100 },
              role: { type: "string", maxLength: 200, description: "Short title." },
              job: { type: "string", maxLength: 600, description: "What it does for this person, in plain words." },
              instructions: { type: "string", maxLength: 6000, description: "Its standing instructions." },
            },
            required: ["name", "role", "job"],
          },
        },
        group_chats: {
          type: "array", maxItems: 4,
          items: {
            type: "object", additionalProperties: false,
            properties: { name: { type: "string", maxLength: 100 }, members: { type: "array", minItems: 2, items: { type: "string" }, description: "Bot names from bots." } },
            required: ["name", "members"],
          },
        },
        first_task: { type: "string", maxLength: 500, description: "One task the person can send to try the team, in their words." },
      },
      required: ["department", "bots"],
    },
  },
];

export async function callTeamTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/team-suggestion", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "The suggestion could not be shown. Try again shortly."), isError: true };
}
