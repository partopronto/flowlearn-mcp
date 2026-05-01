import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { jsonResult, type ToolDef } from "./common.js";

export function buildLessonTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "lesson.list",
      description: "List all lessons of a module.",
      inputSchema: {
        moduleId: z.string(),
      },
      handler: async ({ moduleId }) => {
        const data = await client.request(
          `/api/modules/${moduleId}/lessons`,
        );
        return jsonResult(data);
      },
    },
    {
      name: "lesson.get",
      description:
        "Fetch a single lesson by id, including its module context. Use lesson.get before editing to see the current shape of `content`.",
      inputSchema: {
        lessonId: z.string(),
      },
      handler: async ({ lessonId }) => {
        const data = await client.request(`/api/lessons/${lessonId}`);
        return jsonResult(data);
      },
    },
    {
      name: "lesson.create",
      description:
        "Create a new lesson under a module. The lesson is appended at the end. " +
        "Flow steps are created separately via flowStep.create — the lesson's `content.steps` is a legacy/snapshot field, " +
        "the live flow data is in the flow_steps + flow_connections tables. Server defaults `content` to { steps: [] }.",
      inputSchema: {
        moduleId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        content: z
          .object({ steps: z.array(z.unknown()).optional() })
          .passthrough()
          .optional()
          .describe("Shape: { steps: [] } — usually leave empty and use flowStep.create"),
      },
      handler: async ({ moduleId, ...body }) => {
        const data = await client.request(
          `/api/modules/${moduleId}/lessons`,
          { method: "POST", body },
        );
        return jsonResult(data);
      },
    },
    {
      name: "lesson.update",
      description:
        "Update a lesson's title, description, content, or `flow_completed` marker. " +
        "Set `flow_completed: true` once the lesson's flow steps are complete — required for course publishing.",
      inputSchema: {
        lessonId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        content: z
          .object({ steps: z.array(z.unknown()).optional() })
          .passthrough()
          .optional(),
        flow_completed: z.boolean().optional(),
      },
      handler: async ({ lessonId, ...body }) => {
        const data = await client.request(`/api/lessons/${lessonId}`, {
          method: "PUT",
          body,
        });
        return jsonResult(data);
      },
    },
    {
      name: "lesson.delete",
      description:
        "DESTRUCTIVE: delete a lesson and cascade-delete its flow steps and connections. Remaining lessons in the module are auto-reordered.",
      inputSchema: {
        lessonId: z.string(),
      },
      handler: async ({ lessonId }) => {
        const data = await client.request(`/api/lessons/${lessonId}`, {
          method: "DELETE",
        });
        return jsonResult(data);
      },
    },
  ];
}
