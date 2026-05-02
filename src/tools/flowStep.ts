import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { homedir } from "node:os";
import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdSchema,
  IdempotencyField,
  PaginationFields,
  editorUrl,
  entityResult,
  errorResult,
  getIdempotentScoped,
  listResult,
  paginate,
  setIdempotentScoped,
  type ToolDef,
} from "./common.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Containment root for image_path. By default, only files inside the user's
 * home directory are readable. Override with FLOWLEARN_ALLOWED_IMAGE_DIRS
 * (semicolon-separated absolute paths on Windows, colon-separated on POSIX).
 *
 * Closes the exfiltration vector where a malicious tool caller passes
 * arbitrary image paths (screenshots, scans, photos) to upload them to a
 * public flowlearn URL. The magic-byte sniff blocks text files like
 * /etc/passwd already, but image files anywhere on the disk were readable.
 */
function getAllowedImageRoots(): string[] {
  const env = process.env.FLOWLEARN_ALLOWED_IMAGE_DIRS;
  if (env && env.trim().length > 0) {
    const sep = process.platform === "win32" ? ";" : ":";
    return env
      .split(sep)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => path.resolve(p));
  }
  return [path.resolve(homedir())];
}

function isPathContained(target: string, roots: string[]): boolean {
  const resolved = path.resolve(target);
  for (const root of roots) {
    const normalizedRoot =
      root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved === root || resolved.startsWith(normalizedRoot)) return true;
  }
  return false;
}

/**
 * Reject hosts that resolve to private / loopback / link-local / multicast
 * ranges. Defends image_url against being used as an SSRF probe of the
 * MCP server's internal network. We resolve once and pass the literal IP to
 * fetch — that defeats DNS rebinding, where a public hostname rebinds to a
 * private IP between resolve and fetch.
 */
function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — recurse on the v4 portion.
    const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return isBlockedIp(v4mapped[1]);
    return false;
  }
  return true; // unparseable → reject
}

/**
 * Hosts that reliably serve license-clean (CC / public domain / royalty-free)
 * imagery. URLs from any other host trigger a soft `warnings` advisory in the
 * upload response — agents are expected to reconsider before publishing.
 * Adding hosts here is a deliberate trust signal; don't extend casually.
 */
const CC_LICENSED_HOSTS: ReadonlySet<string> = new Set([
  // Wikimedia family — CC-BY-SA / public domain by policy
  "upload.wikimedia.org",
  "commons.wikimedia.org",
  // Unsplash / Pexels / Pixabay — free-for-commercial-use stock
  "images.unsplash.com",
  "images.pexels.com",
  "cdn.pixabay.com",
  // US-government public-domain sources commonly used in finance/economics
  "www.bls.gov",
  "bls.gov",
  "www.federalreserve.gov",
  "federalreserve.gov",
  "fred.stlouisfed.org",
  "www.sec.gov",
  "sec.gov",
]);

function classifyImageUrlHost(url: string): {
  hostname: string;
  trusted: boolean;
} | null {
  try {
    const u = new URL(url);
    return {
      hostname: u.hostname,
      trusted: CC_LICENSED_HOSTS.has(u.hostname),
    };
  } catch {
    return null;
  }
}

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
  // Containment: only paths under the user's home directory (or an explicit
  // FLOWLEARN_ALLOWED_IMAGE_DIRS list) are readable. Blocks the exfil vector
  // where a malicious caller passes /etc/, C:\Windows\, another user's
  // home, etc.
  const roots = getAllowedImageRoots();
  if (!isPathContained(p, roots)) {
    throw new ImageInputError(
      "IMAGE_PATH_FORBIDDEN",
      `image_path '${p}' is outside the allowed roots.`,
      `Allowed roots: ${roots.join(", ")}. Override with FLOWLEARN_ALLOWED_IMAGE_DIRS env var (semicolon- or colon-separated absolute paths). For programmatic callers, use image_data (base64) instead.`,
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
  // SSRF guard: resolve hostname to IP, reject private/loopback/link-local
  // ranges before any network egress. Pass the literal IP back into fetch
  // (preserving Host header) so DNS rebinding cannot flip a public name to
  // a private IP between resolve and request.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageInputError(
      "INVALID_ARGUMENTS",
      `image_url is not a valid URL.`,
      "Pass a public http(s) URL.",
      false,
    );
  }
  const hostname = parsed.hostname;
  let resolvedIp: string;
  try {
    if (net.isIP(hostname)) {
      resolvedIp = hostname;
    } else {
      const lookup = await dns.lookup(hostname, { verbatim: true });
      resolvedIp = lookup.address;
    }
  } catch {
    throw new ImageInputError(
      "IMAGE_FETCH_FAILED",
      `Could not resolve image_url host.`,
      "Verify the URL hostname.",
      false,
    );
  }
  if (isBlockedIp(resolvedIp)) {
    throw new ImageInputError(
      "IMAGE_URL_FORBIDDEN",
      `image_url host resolves to a private/loopback/link-local IP.`,
      "Use a publicly-routable http(s) URL.",
      false,
    );
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ImageInputError(
      "IMAGE_FETCH_FAILED",
      `Failed to fetch image from URL.`,
      "Verify the URL is reachable.",
      true,
    );
  }
  if (!res.ok) {
    // Generic message — do not echo upstream status (avoids port-scan oracle).
    throw new ImageInputError(
      "IMAGE_FETCH_FAILED",
      `image_url did not return image bytes.`,
      "Verify the URL is publicly accessible and returns image content.",
      true,
    );
  }
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const n = parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > MAX_IMAGE_BYTES) {
      throw new ImageInputError(
        "IMAGE_TOO_LARGE",
        `Image at URL is ${n} bytes (Content-Length); max ${MAX_IMAGE_BYTES} (10 MB).`,
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
        lesson_id: IdSchema,
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
        lesson_id: IdSchema,
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
        const tenantSlug = cfg().tenantSlug;
        const cached = getIdempotentScoped(tenantSlug, client_request_id as string | undefined);
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
          url: editorUrl(cfg().baseUrl, tenantSlug, "flow_step", id, { lessonId: String(lesson_id) }),
          next_actions: [
            `flowlearn_connection_add with flow_step_id="${id}" to wire it to the next step`,
            `flowlearn_flow_step_upload_image with flow_step_id="${id}" if this step needs an image`,
          ],
        });
        setIdempotentScoped(tenantSlug, client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_flow_step_bulk_create",
      description:
        "Create multiple flow steps in a lesson in one call. Eliminates N+1 round-trips when scaffolding linear lessons.\n\n" +
        "When to use: building a lesson's flow steps from a structured array (e.g., 5+ steps); follow-up to flowlearn_lesson_create.\n" +
        "When NOT to use: scaffolding a brand-new course tree — use flowlearn_course_outline_apply (covers modules, lessons, steps, AND connections in one shot); when you need to wire connections — this tool does NOT create connections (call flowlearn_connection_add or flowlearn_connection_replace_all afterwards).\n\n" +
        "Failure mode: NO automatic rollback. If step #3 fails, steps #0–#2 remain in the lesson. Inspect details.partial in the error and either continue manually (flowlearn_flow_step_create for the remainder) or clean up via flowlearn_flow_step_delete. Surfacing partial state explicitly is intentional — silent rollback would mask bugs in the caller's data.\n\n" +
        "Idempotent retry: pass client_request_id; same key returns the cached result without re-creating.\n" +
        "Dry-run: pass dry_run=true to validate the input without mutating.\n\n" +
        'Example call: { "lesson_id": "lsn_abc", "steps": [{"title":"Intro","content":"...","is_starting_step":true},{"title":"Detail","content":"..."}] }\n\n' +
        "Errors: FLOWLEARN_API_404 if lesson_id invalid; FLOWLEARN_BULK_CREATE_PARTIAL with details.created/details.failed_index on mid-batch failure.",
      inputSchema: {
        lesson_id: IdSchema,
        steps: z
          .array(
            z.object({
              title: z.string().min(1),
              content: z.string(),
              description: z.string().optional(),
              step_type: StepTypeEnum.optional(),
              is_starting_step: z.boolean().optional(),
            }).strict(),
          )
          .min(1),
        ...IdempotencyField,
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({
          lesson_id: z.string(),
          count: z.number().int(),
          steps: z.array(FlowStepShape),
        }),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Bulk-create flow steps",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, steps, client_request_id, dry_run }) => {
        const stepArr = steps as Array<{
          title: string;
          content: string;
          description?: string;
          step_type?: string;
          is_starting_step?: boolean;
        }>;

        if (dry_run) {
          return entityResult({
            entity: {
              lesson_id: String(lesson_id),
              count: stepArr.length,
              steps: stepArr as unknown as Record<string, unknown>[],
            },
            summary: `[dry-run] Would create ${stepArr.length} flow step(s) in lesson ${lesson_id}.`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }

        const tenantSlug = cfg().tenantSlug;
        const cached = getIdempotentScoped(tenantSlug, client_request_id as string | undefined);
        if (cached) return cached;

        const created: Record<string, unknown>[] = [];
        for (let i = 0; i < stepArr.length; i++) {
          const s = stepArr[i];
          try {
            const data = await client.request<{ flow_step?: Record<string, unknown> }>(
              `/api/lessons/${lesson_id}/flow-steps`,
              {
                method: "POST",
                body: {
                  title: s.title,
                  content: s.content,
                  description: s.description,
                  step_type: s.step_type ?? "message",
                  is_starting_step: s.is_starting_step ?? false,
                },
              },
            );
            const entity = (data.flow_step ?? data) as Record<string, unknown>;
            created.push(entity);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResult({
              code: "FLOWLEARN_BULK_CREATE_PARTIAL",
              message: `bulk_create failed at step index ${i}: ${message}. ${created.length}/${stepArr.length} steps were created and remain in lesson ${lesson_id}.`,
              suggestion:
                "Inspect details.created for what was created, then either retry the remaining steps individually with flowlearn_flow_step_create, or clean up via flowlearn_flow_step_delete on each created id.",
              retriable: false,
              details: {
                lesson_id: String(lesson_id),
                failed_index: i,
                attempted: stepArr.length,
                created_count: created.length,
                created,
              },
            });
          }
        }

        const result = entityResult({
          entity: {
            lesson_id: String(lesson_id),
            count: created.length,
            steps: created,
          },
          summary: `Created ${created.length} flow step(s) in lesson ${lesson_id}.`,
          next_actions: [
            `flowlearn_connection_add to wire the new steps; or use flowlearn_course_outline_apply next time to bundle steps + connections in one call.`,
          ],
        });
        setIdempotentScoped(tenantSlug, client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_flow_step_move",
      description:
        "Move a flow step to a new position WITHIN ITS CURRENT LESSON. Connections are preserved (reorder is metadata-only).\n\n" +
        "When to use: change the order of steps in a lesson without breaking the connection graph (e.g., swap step 2 and step 3).\n" +
        "When NOT to use: cross-lesson moves — NOT YET SUPPORTED (creates orphan connections); to delete (use flowlearn_flow_step_delete); to reorder ALL steps at once (use flowlearn_flow_step_reorder, which takes the full ordered list).\n\n" +
        "Implementation: thin convenience over flowlearn_flow_step_reorder. Fetches the lesson's current ordered step ids, computes the new ordering with target step in new_position, and submits the full list to the reorder endpoint. The first id in the resulting list becomes the starting step, so moving to position 0 promotes the step to lesson entry.\n\n" +
        "Dry-run: pass dry_run=true to preview the resulting order without mutating.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "new_position": 0 }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid; INVALID_ARGUMENTS if new_position is out of range.",
      inputSchema: {
        flow_step_id: IdSchema,
        new_position: z
          .number()
          .int()
          .min(0)
          .describe("0-indexed target position within the lesson's step list."),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({
          flow_step_id: z.string(),
          lesson_id: z.string(),
          old_position: z.number().int(),
          new_position: z.number().int(),
          ordered_step_ids: z.array(z.string()),
        }),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Move flow step (intra-lesson)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, new_position, dry_run }) => {
        // Resolve the lesson via GET /api/flow-steps/{id}.
        let lessonId: string;
        try {
          const stepResp = await client.request<{ flow_step?: Record<string, unknown> }>(
            `/api/flow-steps/${flow_step_id}`,
          );
          const step = (stepResp.flow_step ?? stepResp) as Record<string, unknown>;
          if (!step.lesson_id) {
            return errorResult({
              code: "FLOWLEARN_API_404",
              message: `Flow step ${flow_step_id} returned no lesson_id; cannot determine which lesson to reorder.`,
              suggestion:
                "Verify flow_step_id via flowlearn_flow_step_list. The API may have changed its response shape.",
              retriable: false,
            });
          }
          lessonId = String(step.lesson_id);
        } catch {
          return errorResult({
            code: "FLOWLEARN_API_404",
            message: `Flow step ${flow_step_id} not found.`,
            suggestion: "Verify the flow_step_id via flowlearn_flow_step_list.",
            retriable: false,
          });
        }

        // Pull the current ordered step list.
        const listResp = await client.request<unknown>(
          `/api/lessons/${lessonId}/flow-steps`,
        );
        const arr = (Array.isArray(listResp)
          ? listResp
          : (listResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<
          string,
          unknown
        >[];
        const ids = arr.map((s) => String(s.id));
        const oldPosition = ids.indexOf(String(flow_step_id));
        if (oldPosition < 0) {
          return errorResult({
            code: "FLOWLEARN_API_404",
            message: `Flow step ${flow_step_id} not found in lesson ${lessonId}'s ordered list.`,
            suggestion:
              "The step may have been deleted between the previous call and this one; refresh via flowlearn_flow_step_list.",
            retriable: false,
          });
        }
        const target = new_position as number;
        if (target >= ids.length) {
          return errorResult({
            code: "INVALID_ARGUMENTS",
            message: `new_position=${target} is out of range; lesson ${lessonId} has ${ids.length} step(s) (max index ${ids.length - 1}).`,
            suggestion: `Use a value between 0 and ${ids.length - 1}.`,
            retriable: false,
          });
        }

        // Compute new order by removing the id from its current slot and
        // inserting at target.
        const reordered = ids.slice();
        reordered.splice(oldPosition, 1);
        reordered.splice(target, 0, String(flow_step_id));

        if (dry_run) {
          return entityResult({
            entity: {
              flow_step_id: String(flow_step_id),
              lesson_id: lessonId,
              old_position: oldPosition,
              new_position: target,
              ordered_step_ids: reordered,
            },
            summary: `[dry-run] Would move step ${flow_step_id} from position ${oldPosition} to ${target} in lesson ${lessonId}.`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }

        await client.request(`/api/lessons/${lessonId}/flow-steps/reorder`, {
          method: "PUT",
          body: { steps: reordered.map((id) => ({ id })) },
        });

        return entityResult({
          entity: {
            flow_step_id: String(flow_step_id),
            lesson_id: lessonId,
            old_position: oldPosition,
            new_position: target,
            ordered_step_ids: reordered,
          },
          summary: `Moved step ${flow_step_id} from position ${oldPosition} to ${target} in lesson ${lessonId}. Connections preserved.`,
          next_actions: [
            `flowlearn_flow_step_list with lesson_id="${lessonId}" to verify.`,
          ],
        });
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
        flow_step_id: IdSchema,
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
              id: IdSchema.optional(),
              targetStepId: IdSchema.nullable().optional(),
              text: z.string().optional(),
              action: ButtonActionEnum.optional(),
            }).strict(),
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
        flow_step_id: IdSchema,
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z
          .object({
            id: z.union([z.string(), z.number()]),
            deleted: z.boolean(),
            dry_run: z.boolean().optional(),
          })
          .passthrough(),
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
          try {
            const preview = await client.request<{ flow_step?: Record<string, unknown> }>(
              `/api/flow-steps/${flow_step_id}`,
            );
            const s = (preview.flow_step ?? preview) as Record<string, unknown>;
            return entityResult({
              entity: { id: String(flow_step_id), deleted: false, dry_run: true, would_delete: s },
              summary: `[dry-run] Would delete flow step '${s.title ?? flow_step_id}' (id=${flow_step_id}) and its connections + image.`,
              next_actions: [`Re-call without dry_run to commit.`],
            });
          } catch {
            return errorResult({
              code: "FLOWLEARN_API_404",
              message: `Could not fetch flow step ${flow_step_id} to preview deletion.`,
              suggestion: "Verify the flow_step_id via flowlearn_flow_step_list.",
              retriable: false,
            });
          }
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
        lesson_id: IdSchema,
        steps: z.array(z.object({ id: IdSchema }).strict()).min(1),
      },
      outputSchema: z.object({
        entity: z.record(z.unknown()),
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
        // Parent-ownership check: every submitted step id MUST belong to
        // lesson_id. Without this, a malicious caller could reorder steps
        // from a different lesson the user happens to also own — orphaning
        // or hijacking them depending on upstream behaviour. We enforce
        // client-side rather than rely on the server to reject.
        const stepArr = steps as { id: string }[];
        const submittedIds = stepArr.map((s) => s.id);
        const listResp = await client.request<unknown>(
          `/api/lessons/${lesson_id}/flow-steps`,
        );
        const owned = (Array.isArray(listResp)
          ? listResp
          : (listResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<string, unknown>[];
        const ownedIds = new Set(owned.map((s) => String(s.id)));
        const foreign = submittedIds.filter((id) => !ownedIds.has(id));
        if (foreign.length > 0) {
          return errorResult({
            code: "INVALID_ARGUMENTS",
            message: `${foreign.length} step id(s) do not belong to lesson ${lesson_id}: ${foreign.join(", ")}.`,
            suggestion: `Call flowlearn_flow_step_list with lesson_id="${lesson_id}" to get the valid ids first.`,
            retriable: false,
            details: { lesson_id: String(lesson_id), foreign_ids: foreign },
          });
        }

        const data = await client.request<unknown>(
          `/api/lessons/${lesson_id}/flow-steps/reorder`,
          { method: "PUT", body: { steps } },
        );
        return entityResult({
          entity: data as Record<string, unknown>,
          summary: `Reordered ${stepArr.length} steps in lesson ${lesson_id}.`,
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
        "License advisory (image_url path only): when image_url's host isn't on the known-CC allowlist (upload.wikimedia.org, images.unsplash.com, images.pexels.com, cdn.pixabay.com, public-domain US gov sites), the response includes a `warnings` array. The upload still succeeds — but the agent should pause and verify the license before publishing, or replace the image with a CC-clean alternative. Hosts NOT on the allowlist are not blocked, but commercial-publisher imagery has bitten this MCP repeatedly.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "image_path": "C:\\\\Users\\\\me\\\\screenshot.png" }\n\n' +
        "Errors: INVALID_ARGUMENTS (zero or multiple sources, relative path, bad URL scheme); IMAGE_TOO_LARGE (>10 MB); IMAGE_INVALID_FORMAT (not PNG/JPEG/WebP/GIF); IMAGE_READ_FAILED (path unreadable); IMAGE_FETCH_FAILED (URL unreachable or non-2xx); FLOWLEARN_API_400 on API rejection; FLOWLEARN_API_404 on bad flow_step_id.",
      inputSchema: {
        flow_step_id: IdSchema,
        image_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute filesystem path to a PNG/JPEG/WebP/GIF file. By default only paths under the user's home directory are allowed; override the allowlist with the FLOWLEARN_ALLOWED_IMAGE_DIRS env var.",
          ),
        image_url: z
          .string()
          .url()
          .optional()
          .describe("Public http(s) URL the MCP server fetches. Private/loopback/link-local IPs are rejected."),
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

        // Soft license advisory: when the image came from a URL whose host
        // isn't on the known-CC allowlist, surface a warning. Doesn't block
        // — the agent decides whether to keep or replace before publishing.
        const warnings: string[] = [];
        if (prepared.source === "url" && image_url) {
          const cls = classifyImageUrlHost(image_url as string);
          if (cls && !cls.trusted) {
            warnings.push(
              `Image source host '${cls.hostname}' is NOT on the known-CC allowlist ` +
                `(upload.wikimedia.org, images.unsplash.com, images.pexels.com, ` +
                `cdn.pixabay.com, public-domain US gov sites). The image uploaded ` +
                `successfully, but its license is unverified. Common pitfall: ` +
                `commercial publisher pages (Fidelity, Britannica, StockCharts, ` +
                `Investopedia, TradingView, *.gitbook.io) and scraped marketing ` +
                `graphics. Before publishing, verify the source's license, ` +
                `or replace via flowlearn_flow_step_delete_image + a CC-clean ` +
                `re-upload (Wikimedia Commons is the safest first stop).`,
            );
          }
        }

        return entityResult({
          entity: data,
          summary: `Uploaded ${prepared.format} image (${prepared.sizeBytes} bytes, source=image_${prepared.source}) for flow step ${flow_step_id}. URL: ${data.image_url ?? "(returned in entity)"}.${warnings.length > 0 ? " ⚠ See warnings[] for license advisory." : ""}`,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      },
    },
    {
      name: "flowlearn_flow_step_delete_image",
      description:
        "Remove the image from a flow step. Idempotent — succeeds silently if no image is set.\n\n" +
        "When to use: clear the image before uploading a replacement, or strip an unwanted image.\n" +
        "When NOT to use: to delete the step itself (use flowlearn_flow_step_delete).\n\n" +
        "Dry-run: pass dry_run=true to verify the step exists and preview the deletion without mutating.\n\n" +
        'Example call: { "flow_step_id": "stp_abc", "dry_run": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid.",
      inputSchema: {
        flow_step_id: IdSchema,
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            image_url: z.string().nullable().optional(),
            dry_run: z.boolean().optional(),
          })
          .passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Delete flow-step image",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, dry_run }) => {
        if (dry_run) {
          try {
            await client.request(`/api/flow-steps/${flow_step_id}`);
          } catch {
            return errorResult({
              code: "FLOWLEARN_API_404",
              message: `Flow step ${flow_step_id} not found.`,
              suggestion: "Verify the flow_step_id via flowlearn_flow_step_list.",
              retriable: false,
            });
          }
          return entityResult({
            entity: { id: String(flow_step_id), dry_run: true },
            summary: `[dry-run] Would delete image from flow step ${flow_step_id}.`,
            next_actions: [`Re-call without dry_run to delete.`],
          });
        }
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
