import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdempotencyField,
  PaginationFields,
  editorUrl,
  entityResult,
  getIdempotent,
  listResult,
  paginate,
  setIdempotent,
  type ToolDef,
} from "./common.js";

const StepTypeEnum = z.enum(["message", "quiz", "exercise"]);
const ButtonActionEnum = z.enum(["next", "help", "skip", "custom", "branch"]);

const FlowStepShape = z
  .object({
    id: z.string(),
    title: z.string(),
    lesson_id: z.string().optional(),
    step_type: StepTypeEnum.optional(),
    content: z.string().nullish(),
    is_starting_step: z.boolean().optional(),
    order_index: z.number().optional(),
    image_url: z.string().nullish(),
  })
  .passthrough();

const FlowStepEnvelope = z.object({
  entity: FlowStepShape,
  summary: z.string(),
  url: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

const FlowStepListEnvelope = z.object({
  items: z.array(FlowStepShape.partial()),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  summary: z.string(),
});

export function buildFlowStepTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    {
      name: "flowlearn_flow_step_list",
      description:
        "List all flow steps of a lesson in order, including their outgoing button connections.\n\n" +
        "When to use: see the lesson's flow graph; find a step id by title; check which step is the entry (`is_starting_step=true`).\n" +
        "When NOT to use: to fetch only the connections of one step — call flowlearn_connection_list directly.\n\n" +
        "Hierarchy: tenant → course → module → lesson → flow_step.\n\n" +
        'Example call: { "lesson_id": "lsn_abc" }\n\n' +
        "Errors: FLOWLEARN_API_404 if lesson_id invalid.",
      inputSchema: {
        lesson_id: z.string().min(1),
        ...PaginationFields,
      },
      outputSchema: FlowStepListEnvelope,
      annotations: {
        title: "List flow steps",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, limit, cursor, response_format }) => {
        const data = await client.request<unknown>(
          `/api/lessons/${lesson_id}/flow-steps`,
        );
        const arr = (Array.isArray(data) ? data : (data as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<string, unknown>[];
        return listResult(
          paginate(arr, {
            limit: limit as number | undefined,
            cursor: cursor as string | undefined,
            format: response_format as "concise" | "detailed" | undefined,
          }),
        );
      },
    },
    {
      name: "flowlearn_flow_step_create",
      description:
        "Create a new flow step inside a lesson.\n\n" +
        "When to use: build out a lesson's flow one step at a time. The first step in a lesson should be created with is_starting_step=true.\n" +
        "When NOT to use: to attach buttons/edges (use flowlearn_connection_add); to upload an image (use flowlearn_flow_step_upload_image AFTER creation).\n\n" +
        "step_type: 'message' (default), 'quiz', or 'exercise' — enforced by a DB CHECK constraint.\n" +
        "Idempotent retry: pass client_request_id.\n\n" +
        'Example call: { "lesson_id": "lsn_abc", "title": "Morning", "content": "Buenos días means good morning.", "is_starting_step": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if lesson_id invalid; FLOWLEARN_API_400 on invalid step_type.",
      inputSchema: {
        lesson_id: z.string().min(1),
        title: z.string().min(1),
        content: z.string().describe("Step body text shown to the learner"),
        description: z.string().optional(),
        step_type: StepTypeEnum.optional().describe("Defaults to 'message' server-side"),
        order_index: z.number().int().optional(),
        is_starting_step: z.boolean().optional(),
        ...IdempotencyField,
      },
      outputSchema: FlowStepEnvelope,
      annotations: {
        title: "Create flow step",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, client_request_id, ...body }) => {
        const cached = getIdempotent(client_request_id as string | undefined);
        if (cached) return cached;
        const data = await client.request<{ flow_step?: Record<string, unknown> }>(
          `/api/lessons/${lesson_id}/flow-steps`,
          { method: "POST", body },
        );
        const entity = (data.flow_step ?? data) as Record<string, unknown>;
        const id = String(entity.id);
        const result = entityResult({
          entity,
          summary: `Created flow step '${entity.title}' (id=${id}, type=${entity.step_type ?? "message"}) in lesson ${lesson_id}.`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "flow_step", id, { lessonId: String(lesson_id) }),
          next_actions: [
            `flowlearn_connection_add with flowStepId="${id}" to wire it to the next step`,
            `flowlearn_flow_step_upload_image with flow_step_id="${id}" if this step needs an image`,
          ],
        });
        setIdempotent(client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_flow_step_update",
      description:
        "Update a flow step's text, video metadata, or outgoing buttons.\n\n" +
        "When to use: edit step content, attach a video URL, or wholesale-replace its outgoing edges via the `buttons` array.\n" +
        "When NOT to use: to add a SINGLE button — call flowlearn_connection_add (clearer intent and safer). Only use the `buttons` field when you want to fully replace the connection set.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "content": "Updated text" }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        content: z.string().optional(),
        step_type: StepTypeEnum.optional(),
        video_url: z.string().url().nullable().optional(),
        video_provider: z.string().nullable().optional(),
        video_thumbnail_url: z.string().url().nullable().optional(),
        buttons: z
          .array(
            z.object({
              id: z.string().optional(),
              targetStepId: z.string().nullable().optional(),
              text: z.string().optional(),
              action: ButtonActionEnum.optional(),
            }),
          )
          .optional()
          .describe("If provided, FULLY REPLACES the step's outgoing connections"),
      },
      outputSchema: FlowStepEnvelope,
      annotations: {
        title: "Update flow step",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, ...body }) => {
        const data = await client.request<{ flow_step?: Record<string, unknown> }>(
          `/api/flow-steps/${flow_step_id}`,
          { method: "PUT", body },
        );
        const entity = (data.flow_step ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? flow_step_id);
        return entityResult({
          entity,
          summary: `Updated flow step '${entity.title}' (id=${id}).`,
        });
      },
    },
    {
      name: "flowlearn_flow_step_delete",
      description:
        "DESTRUCTIVE: delete a flow step. Cascades to its connections and removes its image from storage. Remaining steps in the lesson are auto-reordered.\n\n" +
        "When to use: removing a step at explicit user request.\n" +
        "When NOT to use: to clear all connections of a step (use flowlearn_connection_clear).\n\n" +
        "Dry-run: pass dry_run=true to preview.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "dry_run": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({ id: z.string(), deleted: z.boolean() }).passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Delete flow step",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, dry_run }) => {
        if (dry_run) {
          return entityResult({
            entity: { id: String(flow_step_id), deleted: false, dry_run: true },
            summary: `[dry-run] Would delete flow step ${flow_step_id} and its connections + image.`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }
        await client.request(`/api/flow-steps/${flow_step_id}`, { method: "DELETE" });
        return entityResult({
          entity: { id: String(flow_step_id), deleted: true },
          summary: `Deleted flow step id=${flow_step_id}.`,
        });
      },
    },
    {
      name: "flowlearn_flow_step_reorder",
      description:
        "Reorder all flow steps of a lesson. The first id in the list becomes the starting step.\n\n" +
        "When to use: change step sequence; promote a different step to be the lesson's entry point.\n" +
        "When NOT to use: to delete a step (use flowlearn_flow_step_delete).\n\n" +
        "Pass the COMPLETE ordered list of step ids; partial submissions may be rejected.\n\n" +
        'Example call: { "lesson_id": "lsn_abc", "steps": [{"id":"stp_2"},{"id":"stp_1"},{"id":"stp_3"}] }\n\n' +
        "Errors: FLOWLEARN_API_400 if any id doesn't belong to lesson_id.",
      inputSchema: {
        lesson_id: z.string().min(1),
        steps: z.array(z.object({ id: z.string() })).min(1),
      },
      outputSchema: z.object({
        entity: z.unknown(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Reorder flow steps",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, steps }) => {
        const data = await client.request<unknown>(
          `/api/lessons/${lesson_id}/flow-steps/reorder`,
          { method: "PUT", body: { steps } },
        );
        return entityResult({
          entity: data as Record<string, unknown>,
          summary: `Reordered ${(steps as { id: string }[]).length} steps in lesson ${lesson_id}.`,
          next_actions: [`flowlearn_flow_step_list with lesson_id="${lesson_id}" to verify`],
        });
      },
    },
    {
      name: "flowlearn_flow_step_upload_image",
      description:
        "Upload an image for a flow step. Pass the file as base64-encoded bytes in `image_data` (no data: URI prefix).\n\n" +
        "When to use: attach an illustration, screenshot, or photo to an existing step.\n" +
        "When NOT to use: video — use flowlearn_flow_step_update with video_url instead.\n\n" +
        "Accepted formats: PNG, JPEG, WebP, GIF. Max 10 MB. The server compresses to WebP and returns the public URL.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "image_data": "<base64>" }\n\n' +
        "Errors: FLOWLEARN_API_400 on too-large or invalid image; FLOWLEARN_API_404 on bad flow_step_id.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        image_data: z
          .string()
          .min(1)
          .describe("Base64-encoded image bytes (no data: URI prefix)"),
      },
      outputSchema: z.object({
        entity: z.object({ image_url: z.string().optional() }).passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Upload flow-step image",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, image_data }) => {
        const data = await client.request<Record<string, unknown>>(
          `/api/flow-steps/${flow_step_id}/image`,
          { method: "POST", body: { imageData: image_data } },
        );
        return entityResult({
          entity: data,
          summary: `Uploaded image for flow step ${flow_step_id}. URL: ${data.image_url ?? "(returned in entity)"}.`,
        });
      },
    },
    {
      name: "flowlearn_flow_step_delete_image",
      description:
        "Remove the image from a flow step. Idempotent — succeeds silently if no image is set.\n\n" +
        "When to use: clear the image before uploading a replacement, or strip an unwanted image.\n" +
        "When NOT to use: to delete the step itself (use flowlearn_flow_step_delete).\n\n" +
        'Example call: { "flow_step_id": "stp_abc" }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
      },
      outputSchema: z.object({
        entity: z.unknown(),
        summary: z.string(),
      }),
      annotations: {
        title: "Delete flow-step image",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id }) => {
        const data = await client.request<unknown>(
          `/api/flow-steps/${flow_step_id}/image`,
          { method: "DELETE" },
        );
        return entityResult({
          entity: data as Record<string, unknown>,
          summary: `Removed image from flow step ${flow_step_id}.`,
        });
      },
    },
  ];
}
