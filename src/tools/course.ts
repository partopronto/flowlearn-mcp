import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { jsonResult, type ToolDef } from "./common.js";

export function buildCourseTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "course.list",
      description:
        "List all courses visible to the authenticated tenant admin. Returns id, title, status, and metadata for each.",
      inputSchema: {},
      handler: async () => {
        const data = await client.request("/api/courses");
        return jsonResult(data);
      },
    },
    {
      name: "course.get",
      description:
        "Fetch a single course by id, including its modules. Use this to explore a course before editing.",
      inputSchema: {
        courseId: z.string().describe("UUID of the course"),
      },
      handler: async ({ courseId }) => {
        const data = await client.request(`/api/courses/${courseId}`);
        return jsonResult(data);
      },
    },
    {
      name: "course.create",
      description:
        "Create a new course with explicit metadata. Returns the new course id. " +
        "This tool never invokes server-side AI: the API auto-generates modules only when `goal` is sent on POST, " +
        "so `goal` is intentionally omitted here. Set `goal` later via course.update if needed.",
      inputSchema: {
        title: z.string().min(1),
        topic: z.string().min(1).describe("Required by the server"),
        description: z.string().optional(),
        tone: z.string().optional(),
        difficulty: z
          .enum(["beginner", "intermediate", "advanced"])
          .optional(),
        language: z.string().optional().describe("ISO language code, e.g. en"),
      },
      handler: async (args) => {
        const data = await client.request("/api/courses", {
          method: "POST",
          body: args,
        });
        return jsonResult(data);
      },
    },
    {
      name: "course.update",
      description:
        "Update course metadata. Status transitions to 'published' may be rejected unless `forcePublish` is true and the course has at least one module with a completed lesson.",
      inputSchema: {
        courseId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        topic: z.string().optional(),
        goal: z.string().optional(),
        tone: z.string().optional(),
        difficulty: z
          .enum(["beginner", "intermediate", "advanced"])
          .optional(),
        status: z.enum(["draft", "published", "archived"]).optional(),
        ai_model: z.string().optional(),
        forcePublish: z.boolean().optional(),
      },
      handler: async ({ courseId, ...body }) => {
        const data = await client.request(`/api/courses/${courseId}`, {
          method: "PUT",
          body,
        });
        return jsonResult(data);
      },
    },
    {
      name: "course.delete",
      description:
        "DESTRUCTIVE: permanently delete a course AND cascade-delete all its modules, lessons, flow steps, connections, and uploaded images. Cannot be undone.",
      inputSchema: {
        courseId: z.string(),
      },
      handler: async ({ courseId }) => {
        const data = await client.request(`/api/courses/${courseId}`, {
          method: "DELETE",
        });
        return jsonResult(data);
      },
    },
  ];
}
