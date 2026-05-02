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

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string };

export type ToolResult = {
  content: ToolContent[];
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
  /** flowlearn:// URI that can be read as a resource. When set, the tool
   *  result also includes a resource_link content block so MCP clients
   *  that support it can dereference without an extra tool call. */
  resource_uri?: string;
  next_actions?: string[];
  /** Soft advisories that don't fail the call but the agent should consider
   *  before reporting success to the user (e.g. license suspicion on an
   *  uploaded image). Distinct from `errorResult` which signals an actual
   *  failure. */
  warnings?: string[];
};

/** Standard envelope returned by list tools.
 *
 * NOTE on `total`: this is the count of items the upstream returned in the
 * single fetch this server made — NOT the upstream's grand total. Local
 * pagination (`next_cursor` / `has_more`) only reflects slicing of that
 * single fetched page. The upstream may have additional pages we have not
 * yet retrieved. The `total_is_local` flag below makes that explicit so
 * callers don't mistake `total` for a global count. (The field name is kept
 * for backwards compatibility with existing outputSchemas across tool files.)
 */
export type ListEnvelope<T> = {
  items: T[];
  total: number;
  /** Always true: see JSDoc on ListEnvelope.total. Marker so MCP clients
   *  reading the structured payload can tell `total` is post-upstream-fetch,
   *  pre-local-slice — not a global total. */
  total_is_local: true;
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

/** Wrap an entity as the standard envelope. If resource_uri is set, also
 *  attach a resource_link content block so MCP clients that support it can
 *  dereference the entity as a resource without spending a tool call. */
export function entityResult<T>(envelope: EntityEnvelope<T>): ToolResult {
  const value = envelope as unknown as Record<string, unknown>;
  const content: ToolContent[] = [
    { type: "text", text: JSON.stringify(value, null, 2) },
  ];
  if (envelope.resource_uri) {
    content.push({
      type: "resource_link",
      uri: envelope.resource_uri,
      name: envelope.summary,
    });
  }
  return { content, structuredContent: value };
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
 * In-memory idempotency cache keyed by `${tenantSlug}::${client_request_id}`.
 * Per-process only — a Claude session that retries a `*_create` call after a
 * network blip gets back the original response instead of creating a duplicate.
 *
 * Tenant scoping: keys MUST be prefixed with the active tenant slug. Otherwise
 * a `flowlearn_setup_switch_tenant` followed by a retry of the same
 * client_request_id would return the OLD tenant's cached entity id — silently
 * cross-tenant corruption.
 *
 * Wiring: the active tenant slug is held in a module-level variable updated
 * via `setActiveIdempotencyTenant(slug)`. `src/index.ts` calls it once at
 * startup with the loaded config; `src/tools/setup.ts` calls it after every
 * `client.setTenantSlug(...)`.
 *
 * Unbounded keys are not a concern in practice (one Claude session ≈ <100
 * mutations).
 */
const idempotencyCache = new Map<string, ToolResult>();
let activeIdempotencyTenant = "__unscoped__";

export function setActiveIdempotencyTenant(slug: string): void {
  activeIdempotencyTenant = slug || "__unscoped__";
}

function scopedKey(key: string): string {
  return `${activeIdempotencyTenant}::${key}`;
}

export function getIdempotent(key: string | undefined): ToolResult | undefined {
  if (!key) return undefined;
  return idempotencyCache.get(scopedKey(key));
}

export function setIdempotent(key: string | undefined, result: ToolResult): void {
  if (!key) return;
  idempotencyCache.set(scopedKey(key), result);
}

/**
 * Snapshot-scoped variants. Use these when a handler awaits anything between
 * the lookup and the write (e.g. an upstream POST). They take an explicit
 * tenant scope captured at handler entry, so a concurrent
 * flowlearn_setup_switch_tenant cannot park a tenant-A entity into
 * tenant-B's cache scope while the create is in flight.
 */
export function getIdempotentScoped(
  scope: string,
  key: string | undefined,
): ToolResult | undefined {
  if (!key) return undefined;
  return idempotencyCache.get(`${scope}::${key}`);
}

export function setIdempotentScoped(
  scope: string,
  key: string | undefined,
  result: ToolResult,
): void {
  if (!key) return;
  idempotencyCache.set(`${scope}::${key}`, result);
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
    total_is_local: true,
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

/**
 * Strict ID validator. Flowlearn IDs are short opaque tokens (e.g. `crs_abc123`,
 * `mod_xyz`, `stp_a1b2c3`); they never contain `/`, `..`, whitespace, or
 * control characters. Enforcing the shape at the schema boundary closes the
 * path-traversal vector where an unencoded ID is interpolated into an upstream
 * URL like `/api/courses/${course_id}` — without this, a value like
 * `../register/memberships` reroutes the call to a different authenticated
 * endpoint under the user's session cookie.
 */
export const ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(ID_REGEX, "must be alphanumeric/underscore/hyphen only, max 128 chars");
export const NullableIdSchema = IdSchema.nullable();

/**
 * Defence-in-depth: validate an id at runtime (e.g. after `decodeURIComponent`
 * in resource handlers) before interpolating into an upstream path.
 * Throws if the id is not safe.
 */
export function assertSafeId(id: string, label = "id"): void {
  if (!ID_REGEX.test(id)) {
    throw new Error(
      `Invalid ${label}: must match ${ID_REGEX} (alphanumeric/_/- only, max 128 chars).`,
    );
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
      "Optional idempotency key. If supplied, repeating the call with the same key returns the cached result instead of creating a duplicate. Per-process cache; resets on MCP restart. Cache is scoped to the active tenant — a tenant switch isolates retries (so a key reused after switching does NOT return another tenant's entity id).",
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
