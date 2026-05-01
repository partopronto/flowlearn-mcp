import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdempotencyField,
  PaginationFields,
  editorUrl,
  entityResult,
  errorResult,
  getIdempotent,
  listResult,
  paginate,
  setIdempotent,
  type ToolDef,
} from "./common.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type ImageFormat = "png" | "jpeg" | "gif" | "webp";

class ImageInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string,
    public readonly retriable: boolean,
  ) {
    super(message);
    this.name = "ImageInputError";
  }
}

function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return "gif";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp";
  return null;
}

async function readImageFromPath(p: string): Promise<Buffer> {
  if (!path.isAbsolute(p)) {
    throw new ImageInputError(
      "INVALID_ARGUMENTS",
      `image_path must be an absolute path; got '${p}'.`,
      "Pass a fully-qualified path (e.g. C:\\Users\\me\\shot.png on Windows, /home/me/shot.png on Linux/macOS). The MCP server's CWD is not assumed.",
      false,
    );
  }
  try {
    return await fs.readFile(p);
  } catch (err) {
    throw new ImageInputError(
      "IMAGE_READ_FAILED",
      `Could not read image at ${p}: ${(err as Error).message}`,
      "Check that the file exists and is readable by the MCP server process.",
      true,
    );
  }
}

async function fetchImageFromUrl(url: string): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ImageInputError(
      "INVALID_ARGUMENTS",
      `image_url must be http(s); got '${url}'.`,
      "Use a public http(s) URL the MCP server can reach.",
      false,
    );
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ImageInputError(
      "IMAGE_FETCH_FAILED",
      `Failed to fetch ${url}: ${(err as Error).message}`,
      "Verify the URL is reachable from the machine running the MCP server.",
      true,
    );
  }
  if (!res.ok) {
    throw new ImageInputError(
      "IMAGE_FETCH_FAILED",
      `Fetch ${url} returned HTTP ${res.status}.`,
      "Verify the URL returns image bytes (HTTP 200) and is publicly accessible.",
      true,
    );
  }
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const n = parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > MAX_IMAGE_BYTES) {
      throw new ImageInputError(
        "IMAGE_TOO_LARGE",
        `Image at ${url} is ${n} bytes (Content-Length); max ${MAX_IMAGE_BYTES} (10 MB).`,
        "Compress the image below 10 MB before uploading.",
        false,
      );
    }
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function decodeImageData(b64: string): Buffer {
  const stripped = b64.startsWith("data:")
    ? b64.replace(/^data:[^;]*;base64,/, "")
    : b64;
  const buf = Buffer.from(stripped, "base64");
  if (buf.length === 0) {
    throw new ImageInputError(
      "INVALID_ARGUMENTS",
      "image_data decoded to 0 bytes (not valid base64, or empty).",
      "Pass non-empty base64-encoded image bytes (no data: URI prefix).",
      false,
    );
  }
  return buf;
}

async function loadAndValidateImage(args: {
  image_path?: string;
  image_url?: string;
  image_data?: string;
}): Promise<{
  base64: string;
  format: ImageFormat;
  sizeBytes: number;
  source: "path" | "url" | "data";
}> {
  const provided: Array<"path" | "url" | "data"> = [];
  if (args.image_path) provided.push("path");
  if (args.image_url) provided.push("url");
  if (args.image_data) provided.push("data");

  if (provided.length === 0) {
    throw new ImageInputError(
      "INVALID_ARGUMENTS",
      "Exactly one of image_path, image_url, or image_data must be provided.",
      "Pass image_path (absolute filesystem path) for local files, image_url for a public http(s) URL, or image_data (base64) for programmatic callers.",
      false,
    );
  }
  if (provided.length > 1) {
    throw new ImageInputError(
      "INVALID_ARGUMENTS",
      `Only one image source allowed; got ${provided.length}: ${provided.map((p) => "image_" + p).join(", ")}.`,
      "Provide exactly one of image_path, image_url, or image_data.",
      false,
    );
  }

  let buf: Buffer;
  const source = provided[0];
  if (source === "path") buf = await readImageFromPath(args.image_path!);
  else if (source === "url") buf = await fetchImageFromUrl(args.image_url!);
  else buf = decodeImageData(args.image_data!);

  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError(
      "IMAGE_TOO_LARGE",
      `Image is ${buf.length} bytes; max ${MAX_IMAGE_BYTES} (10 MB).`,
      "Compress the image below 10 MB before uploading.",
      false,
    );
  }

  const format = sniffImageFormat(buf);
  if (!format) {
    throw new ImageInputError(
      "IMAGE_INVALID_FORMAT",
      "Image bytes do not match PNG, JPEG, WebP, or GIF magic bytes.",
      "Re-export the image as PNG, JPEG, WebP, or GIF and try again.",
      false,
    );
  }

  return {
    base64: buf.toString("base64"),
    format,
    sizeBytes: buf.length,
    source,
  };
}

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
        "Upload an image for a flow step. Provide EXACTLY ONE source:\n" +
        "  • image_path — absolute filesystem path (PREFERRED for Claude Code; the MCP server reads and base64-encodes the file)\n" +
        "  • image_url — public http(s) URL (the MCP server fetches the bytes)\n" +
        "  • image_data — base64-encoded bytes, no data: URI prefix (programmatic callers)\n\n" +
        "When to use: attach an illustration, screenshot, or photo to an existing step.\n" +
        "When NOT to use: video — use flowlearn_flow_step_update with video_url instead.\n\n" +
        "Why image_path is preferred from Claude Code: a pasted screenshot reaches the model only as a multimodal image block — the model cannot serialize it back to base64 to fit the image_data parameter. Save the screenshot to disk (Snipping Tool / Win+Shift+S → save / drag-drop a file into the terminal) and pass its absolute path here.\n\n" +
        "Accepted formats: PNG, JPEG, WebP, GIF (sniffed by magic bytes). Max 10 MB. The Flowlearn server compresses to WebP and returns the public URL.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "image_path": "C:\\\\Users\\\\me\\\\screenshot.png" }\n\n' +
        "Errors: INVALID_ARGUMENTS (zero or multiple sources, relative path, bad URL scheme); IMAGE_TOO_LARGE (>10 MB); IMAGE_INVALID_FORMAT (not PNG/JPEG/WebP/GIF); IMAGE_READ_FAILED (path unreadable); IMAGE_FETCH_FAILED (URL unreachable or non-2xx); FLOWLEARN_API_400 on API rejection; FLOWLEARN_API_404 on bad flow_step_id.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        image_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute filesystem path to a PNG/JPEG/WebP/GIF file. Preferred for Claude Code users.",
          ),
        image_url: z
          .string()
          .url()
          .optional()
          .describe("Public http(s) URL the MCP server fetches."),
        image_data: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Base64-encoded image bytes (no data: URI prefix). Use only if you already have the bytes in memory; Claude Code typically cannot produce this from a paste.",
          ),
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
      handler: async ({ flow_step_id, image_path, image_url, image_data }) => {
        let prepared;
        try {
          prepared = await loadAndValidateImage({
            image_path: image_path as string | undefined,
            image_url: image_url as string | undefined,
            image_data: image_data as string | undefined,
          });
        } catch (err) {
          if (err instanceof ImageInputError) {
            return errorResult({
              code: err.code,
              message: err.message,
              suggestion: err.suggestion,
              retriable: err.retriable,
            });
          }
          throw err;
        }

        const data = await client.request<Record<string, unknown>>(
          `/api/flow-steps/${flow_step_id}/image`,
          { method: "POST", body: { imageData: prepared.base64 } },
        );
        return entityResult({
          entity: data,
          summary: `Uploaded ${prepared.format} image (${prepared.sizeBytes} bytes, source=image_${prepared.source}) for flow step ${flow_step_id}. URL: ${data.image_url ?? "(returned in entity)"}.`,
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
