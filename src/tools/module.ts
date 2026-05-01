import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { jsonResult, type ToolDef } from "./common.js";

export function buildModuleTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "module.list",
      description:
        "List all modules of a course, including a lesson count for each.",
      inputSchema: {
        courseId: z.string(),
      },
      handler: async ({ courseId }) => {
        const data = await client.request(
          `/api/courses/${courseId}/modules`,
        );
        return jsonResult(data);
      },
    },
    {
      name: "module.create",
      description:
        "Create a new module under a course. The module is appended at the end (highest order_index). " +
        "`content` is a JSON object; the only field the rest of the codebase reads is `objectives: string[]`.",
      inputSchema: {
        courseId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        content: z
          .object({ objectives: z.array(z.string()).optional() })
          .passthrough()
          .optional()
          .describe("Shape: { objectives: string[] }"),
      },
      handler: async ({ courseId, ...body }) => {
        const data = await client.request(
          `/api/courses/${courseId}/modules`,
          { method: "POST", body },
        );
        return jsonResult(data);
      },
    },
    {
      name: "module.update",
      description:
        "Update a module's title, description, or content JSON. " +
        "Same content shape as module.create — { objectives: string[] }.",
      inputSchema: {
        moduleId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        content: z
          .object({ objectives: z.array(z.string()).optional() })
          .passthrough()
          .optional(),
      },
      handler: async ({ moduleId, ...body }) => {
        const data = await client.request(`/api/modules/${moduleId}`, {
          method: "PUT",
          body,
        });
        return jsonResult(data);
      },
    },
    {
      name: "module.delete",
      description:
        "DESTRUCTIVE: delete a module and cascade-delete all of its lessons, flow steps, and connections. Remaining modules are auto-reordered.",
      inputSchema: {
        moduleId: z.string(),
      },
      handler: async ({ moduleId }) => {
        const data = await client.request(`/api/modules/${moduleId}`, {
          method: "DELETE",
        });
        return jsonResult(data);
      },
    },
    {
      name: "module.reorder",
      description:
        "Reorder all modules of a course. Pass the full ordered list of module ids with their new order_index values.",
      inputSchema: {
        courseId: z.string(),
        modules: z
          .array(z.object({ id: z.string(), order_index: z.number().int() }))
          .min(1),
      },
      handler: async ({ courseId, modules }) => {
        const data = await client.request(
          `/api/courses/${courseId}/modules/reorder`,
          { method: "PUT", body: { modules } },
        );
        return jsonResult(data);
      },
    },
  ];
}
