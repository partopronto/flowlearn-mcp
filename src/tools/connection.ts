import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { jsonResult, type ToolDef } from "./common.js";

export function buildConnectionTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "connection.list",
      description:
        "List all outgoing connections (button edges) from a flow step.",
      inputSchema: {
        flowStepId: z.string(),
      },
      handler: async ({ flowStepId }) => {
        const data = await client.request(
          `/api/flow-steps/${flowStepId}/connections`,
        );
        return jsonResult(data);
      },
    },
    {
      name: "connection.add",
      description:
        "Add a single outgoing connection (button edge) from a flow step. " +
        "`to_step_id` may be null for terminal buttons.",
      inputSchema: {
        flowStepId: z.string(),
        to_step_id: z.string().nullable(),
        button_text: z.string().min(1),
        button_action: z
          .enum(["next", "help", "skip", "custom", "branch"])
          .optional()
          .describe("Defaults to 'next' server-side"),
        button_order: z.number().int().min(1),
      },
      handler: async ({ flowStepId, ...body }) => {
        const data = await client.request(
          `/api/flow-steps/${flowStepId}/connections`,
          { method: "POST", body },
        );
        return jsonResult(data);
      },
    },
    {
      name: "connection.replaceAll",
      description:
        "DESTRUCTIVE: fully replace all outgoing connections from a flow step with the supplied list. " +
        "Any existing connection not in the new list is deleted. Use connection.add to append a single edge instead.",
      inputSchema: {
        flowStepId: z.string(),
        connections: z
          .array(
            z.object({
              to_step_id: z.string().nullable(),
              button_text: z.string().min(1),
              button_action: z
                .enum(["next", "help", "skip", "custom", "branch"])
                .optional(),
              button_order: z.number().int().min(1),
            }),
          )
          .min(0),
      },
      handler: async ({ flowStepId, connections }) => {
        const data = await client.request(
          `/api/flow-steps/${flowStepId}/connections`,
          { method: "PUT", body: { connections } },
        );
        return jsonResult(data);
      },
    },
    {
      name: "connection.clear",
      description:
        "DESTRUCTIVE: delete all outgoing connections from a flow step.",
      inputSchema: {
        flowStepId: z.string(),
      },
      handler: async ({ flowStepId }) => {
        const data = await client.request(
          `/api/flow-steps/${flowStepId}/connections`,
          { method: "DELETE" },
        );
        return jsonResult(data);
      },
    },
  ];
}
