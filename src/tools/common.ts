import { z } from "zod";

/**
 * MCP tool annotations — hints to the client about side-effect classification.
 * Per the MCP spec, all default to "unsafe" (false / open-world) so silence ≠
 * permission. Setting these correctly lets clients auto-approve safe ops and
 * gate destructive ones.
 */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Zod schema for the structured output. Converted to JSON Schema and
   *  emitted as `outputSchema` so agents know the return shape without
   *  trial-and-error. Optional for tools whose output is genuinely free-form. */
  outputSchema?: z.ZodTypeAny;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  /** Structured JSON payload — modern clients prefer this; we emit it
   *  alongside the text rendering for backwards compat. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Standard envelope returned by mutating tools. */
export type EntityEnvelope<T> = {
  entity: T;
  summary: string;
  url?: string;
  next_actions?: string[];
};

/** Standard envelope returned by list tools. */
export type ListEnvelope<T> = {
  items: T[];
  total: number;
  next_cursor: string | null;
  has_more: boolean;
  summary: string;
};

/** Structured-error envelope used for tool-level (not protocol-level) failures. */
export type ErrorEnvelope = {
  code: string;
  message: string;
  suggestion?: string;
  retriable: boolean;
  details?: Record<string, unknown>;
};

/** Wrap a structured payload as an MCP ToolResult. The text rendering is the
 *  pretty-printed JSON, the structured content is the raw object. */
export function structured<T extends Record<string, unknown>>(value: T): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/** Wrap an entity as the standard envelope. */
export function entityResult<T>(envelope: EntityEnvelope<T>): ToolResult {
  return structured(envelope as unknown as Record<string, unknown>);
}

/** Wrap a list as the standard envelope. */
export function listResult<T>(envelope: ListEnvelope<T>): ToolResult {
  return structured(envelope as unknown as Record<string, unknown>);
}

/** Return a structured error result. Use this for ALL tool-level failures
 *  instead of throwing — the agent gets `code` + actionable `suggestion`
 *  instead of an unstructured message. */
export function errorResult(err: ErrorEnvelope): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
    structuredContent: err as unknown as Record<string, unknown>,
    isError: true,
  };
}

/**
 * Build a flowlearn editor URL for a given entity. Best-effort — if the type
 * isn't recognised, returns undefined and the caller omits the field.
 */
export function editorUrl(
  baseUrl: string,
  tenantSlug: string,
  kind: "course" | "module" | "lesson" | "flow_step",
  id: string,
  ctx?: { courseId?: string; lessonId?: string },
): string | undefined {
  const root = `${baseUrl}/${tenantSlug}`;
  switch (kind) {
    case "course":
      return `${root}/courses/${id}/edit`;
    case "module":
      return ctx?.courseId
        ? `${root}/courses/${ctx.courseId}/modules/${id}`
        : undefined;
    case "lesson":
      return `${root}/lessons/${id}/edit`;
    case "flow_step":
      return ctx?.lessonId
        ? `${root}/lessons/${ctx.lessonId}/edit?step=${id}`
        : undefined;
  }
}

/**
 * In-memory idempotency cache keyed by client_request_id. Per-process only —
 * a Claude session that retries a `*_create` call after a network blip gets
 * back the original response instead of creating a duplicate. Unbounded keys
 * are not a concern in practice (one Claude session ≈ <100 mutations).
 */
const idempotencyCache = new Map<string, ToolResult>();

export function getIdempotent(key: string | undefined): ToolResult | undefined {
  if (!key) return undefined;
  return idempotencyCache.get(key);
}

export function setIdempotent(key: string | undefined, result: ToolResult): void {
  if (!key) return;
  idempotencyCache.set(key, result);
}

/**
 * Apply MCP-side pagination to an array. Cursor is a base64-encoded numeric
 * offset, future-proofed against API change. response_format=concise strips
 * the items down to {id, title} (best-effort) for cheap iteration.
 */
export function paginate<T extends Record<string, unknown>>(
  items: T[],
  opts: { limit?: number; cursor?: string; format?: "concise" | "detailed" },
): ListEnvelope<T | { id: unknown; title: unknown }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = decodeCursor(opts.cursor);
  const slice = items.slice(offset, offset + limit);
  const has_more = offset + limit < items.length;
  const next_cursor = has_more ? encodeCursor(offset + limit) : null;
  const projected =
    opts.format === "concise"
      ? slice.map((it) => ({ id: it.id, title: it.title }))
      : slice;
  return {
    items: projected,
    total: items.length,
    next_cursor,
    has_more,
    summary: `Returned ${slice.length} of ${items.length} items.`,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const n = parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Common Zod fields reused across tools. */
export const PaginationFields = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max items per page (default 50, max 200)"),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous response's `next_cursor`"),
  response_format: z
    .enum(["concise", "detailed"])
    .optional()
    .describe(
      "concise = {id, title} only; detailed = full record. Default detailed.",
    ),
};

export const IdempotencyField = {
  client_request_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Optional idempotency key. If supplied, repeating the call with the same key returns the cached result instead of creating a duplicate. Per-process cache; resets on MCP restart.",
    ),
};

export const DryRunField = {
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "If true, do NOT mutate; return what WOULD happen. Use to preview destructive ops before committing.",
    ),
};
