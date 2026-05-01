import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { jsonResult, type ToolDef } from "./common.js";

export function buildFlowStepTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "flowStep.list",
      description:
        "List all flow steps of a lesson, including their outgoing button connections.",
      inputSchema: {
        lessonId: z.string(),
      },
      handler: async ({ lessonId }) => {
        const data = await client.request(
          `/api/lessons/${lessonId}/flow-steps`,
        );
        return jsonResult(data);
      },
    },
    {
      name: "flowStep.create",
      description:
        "Create a new flow step within a lesson. " +
        "`step_type` is enforced by the database CHECK constraint. " +
        "Set `is_starting_step: true` to mark this as the lesson's entry point.",
      inputSchema: {
        lessonId: z.string(),
        title: z.string().min(1),
        content: z.string().describe("Step body text shown to the learner"),
        description: z.string().optional(),
        step_type: z
          .enum(["message", "quiz", "exercise"])
          .optional()
          .describe("Defaults to 'message' server-side"),
        order_index: z.number().int().optional(),
        is_starting_step: z.boolean().optional(),
      },
      handler: async ({ lessonId, ...body }) => {
        const data = await client.request(
          `/api/lessons/${lessonId}/flow-steps`,
          { method: "POST", body },
        );
        return jsonResult(data);
      },
    },
    {
      name: "flowStep.update",
      description:
        "Update a flow step's text and/or video fields. " +
        "Note: this endpoint also accepts a `buttons` array that fully replaces the step's outgoing connections — " +
        "prefer the connection.* tools for clearer intent unless you are doing both at once.",
      inputSchema: {
        flowStepId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        content: z.string().optional(),
        step_type: z.enum(["message", "quiz", "exercise"]).optional(),
        video_url: z.string().url().nullable().optional(),
        video_provider: z.string().nullable().optional(),
        video_thumbnail_url: z.string().url().nullable().optional(),
        buttons: z
          .array(
            z.object({
              id: z.string().optional(),
              targetStepId: z.string().nullable().optional(),
              text: z.string().optional(),
              action: z
                .enum(["next", "help", "skip", "custom", "branch"])
                .optional(),
            }),
          )
          .optional()
          .describe("If provided, fully replaces the step's outgoing connections"),
      },
      handler: async ({ flowStepId, ...body }) => {
        const data = await client.request(`/api/flow-steps/${flowStepId}`, {
          method: "PUT",
          body,
        });
        return jsonResult(data);
      },
    },
    {
      name: "flowStep.delete",
      description:
        "DESTRUCTIVE: delete a flow step. Cascades to its connections and removes its image from storage. Remaining steps in the lesson are auto-reordered.",
      inputSchema: {
        flowStepId: z.string(),
      },
      handler: async ({ flowStepId }) => {
        const data = await client.request(`/api/flow-steps/${flowStepId}`, {
          method: "DELETE",
        });
        return jsonResult(data);
      },
    },
    {
      name: "flowStep.reorder",
      description:
        "Reorder all flow steps of a lesson. Pass the full ordered list of step ids; the first id becomes the starting step.",
      inputSchema: {
        lessonId: z.string(),
        steps: z.array(z.object({ id: z.string() })).min(1),
      },
      handler: async ({ lessonId, steps }) => {
        const data = await client.request(
          `/api/lessons/${lessonId}/flow-steps/reorder`,
          { method: "PUT", body: { steps } },
        );
        return jsonResult(data);
      },
    },
    {
      name: "flowStep.uploadImage",
      description:
        "Upload an image for a flow step. Pass the file as base64-encoded bytes in `imageData`. " +
        "Accepted formats: PNG, JPEG, WebP, GIF. Max 10 MB. The server compresses to WebP and returns the public URL.",
      inputSchema: {
        flowStepId: z.string(),
        imageData: z
          .string()
          .min(1)
          .describe("Base64-encoded image bytes (no data: URI prefix)"),
      },
      handler: async ({ flowStepId, imageData }) => {
        const data = await client.request(
          `/api/flow-steps/${flowStepId}/image`,
          { method: "POST", body: { imageData } },
        );
        return jsonResult(data);
      },
    },
    {
      name: "flowStep.deleteImage",
      description:
        "DESTRUCTIVE: remove the image from a flow step. Idempotent — succeeds silently if no image is set.",
      inputSchema: {
        flowStepId: z.string(),
      },
      handler: async ({ flowStepId }) => {
        const data = await client.request(
          `/api/flow-steps/${flowStepId}/image`,
          { method: "DELETE" },
        );
        return jsonResult(data);
      },
    },
  ];
}
