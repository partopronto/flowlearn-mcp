import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowlearnClient } from "../client.js";
import { entityResult, errorResult, type ToolDef } from "./common.js";

const ADMIN_ROLES = ["tenant_admin", "creator", "super_admin"] as const;

type Membership = {
  tenant_id: string;
  slug: string;
  name: string;
  role: string;
};

const PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENV_FILE_PATH = join(PACKAGE_ROOT, ".env");
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const SERVER_NAME = "flowlearn";

function updateEnvFile(path: string, updates: Record<string, string>): void {
  let lines: string[] = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf-8").split(/\r?\n/);
  }

  const seen = new Set<string>();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      return line;
    }
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  writeFileSync(path, newLines.join("\n"), "utf-8");
}

function updateClaudeMcpEnv(
  serverName: string,
  updates: Record<string, string>,
): string {
  if (!existsSync(CLAUDE_CONFIG_PATH)) {
    throw new Error(
      `${CLAUDE_CONFIG_PATH} does not exist. Cannot update MCP credentials before initial registration.`,
    );
  }

  const text = readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
  const config = JSON.parse(text);

  if (!config.mcpServers || !config.mcpServers[serverName]) {
    throw new Error(
      `MCP '${serverName}' not registered in ${CLAUDE_CONFIG_PATH}. ` +
        `Run \`python scripts/register.py\` from a terminal first.`,
    );
  }

  const existing = config.mcpServers[serverName].env ?? {};
  config.mcpServers[serverName].env = { ...existing, ...updates };

  writeFileSync(
    CLAUDE_CONFIG_PATH,
    JSON.stringify(config, null, 2),
    "utf-8",
  );
  return CLAUDE_CONFIG_PATH;
}

async function validateCredentials(
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      throw new Error(
        `New credentials rejected (401). The current setup is unchanged. ` +
          `Body: ${body}`,
      );
    }
    throw new Error(
      `New credentials check failed with HTTP ${res.status}. ` +
        `The current setup is unchanged. Body: ${body}`,
    );
  }
}

export function buildSetupTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "flowlearn_setup_status",
      description:
        "Canonical entry point: returns who is signed in, active tenant, all admin tenants, recent courses on the active tenant, and a suggested next action. Confirms auth still works.\n\n" +
        "When to use: at the start of a session to orient yourself; after a tenant switch; whenever you're unsure of state.\n" +
        "When NOT to use: as a tool-call replacement for actions — this is read-only orientation.\n\n" +
        "Returns:\n" +
        "  email                   — the signed-in user\n" +
        "  active_tenant_slug      — the tenant tools currently act on\n" +
        "  active_tenant           — full membership record (or null if not a member)\n" +
        "  active_tenant_is_admin  — whether the role grants write access\n" +
        "  all_admin_tenants       — every tenant where the user has an admin role\n" +
        "  recent_courses          — up to 10 most-recent courses on the active tenant (id, title, status)\n" +
        "  suggested_next_action   — concrete next tool to call\n" +
        "  auth_confirmed          — true if a fresh-or-cached cookie validated\n\n" +
        'Example call: {} (no arguments)\n\n' +
        "Errors: FLOWLEARN_API_401 if credentials invalid — call flowlearn_setup_update to fix.",
      inputSchema: {},
      outputSchema: z.object({
        entity: z
          .object({
            email: z.string(),
            active_tenant_slug: z.string(),
            active_tenant: z.unknown().nullable(),
            active_tenant_is_admin: z.boolean(),
            all_admin_tenants: z.array(z.unknown()),
            recent_courses: z.array(
              z.object({ id: z.string(), title: z.string(), status: z.string().optional() }).passthrough(),
            ),
            suggested_next_action: z.string(),
            auth_confirmed: z.boolean(),
          })
          .passthrough(),
        summary: z.string(),
      }),
      annotations: {
        title: "Status / orientation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const data = await client.request<{ memberships?: Membership[] }>(
          "/api/register/memberships",
        );
        const memberships = data.memberships ?? [];
        const cfg = client.getConfig();
        const currentTenant =
          memberships.find((m) => m.slug === cfg.tenantSlug) ?? null;
        const adminTenants = memberships.filter((m) =>
          (ADMIN_ROLES as readonly string[]).includes(m.role),
        );
        const activeIsAdmin = currentTenant
          ? (ADMIN_ROLES as readonly string[]).includes(currentTenant.role)
          : false;

        let recentCourses: Array<{ id: string; title: string; status?: string }> = [];
        if (activeIsAdmin) {
          try {
            const courseData = await client.request<unknown>("/api/courses");
            const arr = (Array.isArray(courseData) ? courseData : (courseData as { courses?: unknown[] })?.courses ?? []) as Record<string, unknown>[];
            recentCourses = arr.slice(0, 10).map((c) => ({
              id: String(c.id),
              title: String(c.title),
              status: c.status as string | undefined,
            }));
          } catch {
            // Non-fatal — status should still return useful info.
          }
        }

        const suggested = !activeIsAdmin
          ? `You are not an admin on '${cfg.tenantSlug}'. Call flowlearn_setup_switch_tenant with one of: ${adminTenants.map((m) => m.slug).join(", ") || "(no admin tenants)"}.`
          : recentCourses.length === 0
            ? `Tenant '${cfg.tenantSlug}' has no courses yet. Call flowlearn_course_create to start.`
            : `Tenant '${cfg.tenantSlug}' has ${recentCourses.length}+ courses. Call flowlearn_course_list to browse, or flowlearn_course_get with one of the ids in recent_courses.`;

        return entityResult({
          entity: {
            email: cfg.email,
            active_tenant_slug: cfg.tenantSlug,
            active_tenant: currentTenant,
            active_tenant_is_admin: activeIsAdmin,
            all_admin_tenants: adminTenants,
            recent_courses: recentCourses,
            suggested_next_action: suggested,
            auth_confirmed: true,
          },
          summary: `Signed in as ${cfg.email}, active tenant '${cfg.tenantSlug}' (admin=${activeIsAdmin}). ${recentCourses.length} recent course(s) cached.`,
        });
      },
    },
    {
      name: "flowlearn_setup_switch_tenant",
      description:
        "Switch which tenant the MCP acts on for the rest of this session. IN-MEMORY ONLY — reverts on Claude restart.\n\n" +
        "When to use: temporarily try acting on a different tenant. The slug must belong to one of your admin-role memberships.\n" +
        "When NOT to use: to make a permanent change — use flowlearn_setup_update with the slug field, or run `python scripts/register.py --slug <slug>` in a terminal.\n\n" +
        'Example call: { "slug": "acme" }\n\n' +
        "Errors: returns INVALID_TENANT or NOT_ADMIN with the list of valid slugs in suggestion.",
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe("Slug of one of your admin-role tenants"),
      },
      outputSchema: z.object({
        entity: z
          .object({
            switched: z.boolean(),
            previous_slug: z.string(),
            active_tenant: z.unknown(),
            persistence: z.string(),
          })
          .passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Switch tenant (in-memory)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ slug }) => {
        const newSlug = String(slug).toLowerCase();
        const cfg = client.getConfig();
        const previousSlug = cfg.tenantSlug;

        const data = await client.request<{ memberships?: Membership[] }>(
          "/api/register/memberships",
        );
        const memberships = data.memberships ?? [];
        const match = memberships.find((m) => m.slug === newSlug);

        if (!match) {
          const available = memberships.map((m) => m.slug).join(", ");
          return errorResult({
            code: "INVALID_TENANT",
            message: `'${newSlug}' is not one of your tenants.`,
            suggestion: `Available: ${available || "(none)"}.`,
            retriable: false,
            details: { available_slugs: memberships.map((m) => m.slug) },
          });
        }
        if (!(ADMIN_ROLES as readonly string[]).includes(match.role)) {
          return errorResult({
            code: "NOT_ADMIN",
            message: `Your role on '${newSlug}' is '${match.role}', which is not an admin role.`,
            suggestion: `Required: ${ADMIN_ROLES.join(", ")}.`,
            retriable: false,
          });
        }

        client.setTenantSlug(newSlug);

        return entityResult({
          entity: {
            switched: true,
            previous_slug: previousSlug,
            active_tenant: match,
            persistence: "in-memory only for this session",
          },
          summary: `Switched active tenant from '${previousSlug}' to '${newSlug}' (in-memory only).`,
          next_actions: [
            `flowlearn_setup_update with slug="${newSlug}" to make permanent`,
            `flowlearn_course_list to see courses on the new tenant`,
          ],
        });
      },
    },
    {
      name: "flowlearn_setup_update",
      description:
        "Persistently update one or more of email/password/tenant slug. Validates new credentials before writing.\n\n" +
        "When to use: rotate password; switch primary tenant permanently; change the signed-in account.\n" +
        "When NOT to use: temporary tenant switches (use flowlearn_setup_switch_tenant).\n\n" +
        "WARNING: passing a password as a tool argument means it appears in the Claude Code chat transcript. For sensitive rotations, run `python scripts/register.py` in a terminal instead (hidden prompt, no transcript).\n\n" +
        "Writes to BOTH ~/.claude.json AND the package's .env. The current process picks up new values immediately — no Claude restart required. If validation fails, nothing is written.\n\n" +
        'Example call: { "slug": "newtenant" }\n\n' +
        "Errors: validation_failed (creds rejected); INVALID_TENANT (slug not in memberships); NOT_ADMIN (slug role insufficient).",
      inputSchema: {
        email: z.string().email().optional(),
        password: z.string().min(1).optional(),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe("Lowercased; must be an admin-role tenant"),
      },
      outputSchema: z.object({
        entity: z
          .object({
            updated: z.object({
              email: z.boolean(),
              password: z.boolean(),
              slug: z.boolean(),
            }),
            active_tenant: z.unknown().nullable(),
            persisted_to: z.array(z.string()),
            session_status: z.string(),
            restart_required: z.boolean(),
          })
          .passthrough(),
        summary: z.string(),
      }),
      annotations: {
        title: "Update credentials/tenant (persistent)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ email, password, slug }) => {
        if (!email && !password && !slug) {
          return errorResult({
            code: "NO_FIELDS_PROVIDED",
            message: "Provide at least one of: email, password, slug.",
            retriable: true,
          });
        }

        const cfg = client.getConfig();
        const newEmail = (email as string | undefined) ?? cfg.email;
        const newPassword = (password as string | undefined) ?? cfg.password;
        const newSlug = slug ? String(slug).toLowerCase() : cfg.tenantSlug;

        await validateCredentials(cfg.baseUrl, newEmail, newPassword);

        let newTenant: Membership | null = null;
        if (slug) {
          const data = await client.request<{ memberships?: Membership[] }>(
            "/api/register/memberships",
          );
          const memberships = data.memberships ?? [];
          const match = memberships.find((m) => m.slug === newSlug);
          if (!match) {
            return errorResult({
              code: "INVALID_TENANT",
              message: `Tenant slug '${newSlug}' not found in your memberships.`,
              suggestion: `Available: ${memberships.map((m) => m.slug).join(", ") || "(none)"}.`,
              retriable: false,
            });
          }
          if (!(ADMIN_ROLES as readonly string[]).includes(match.role)) {
            return errorResult({
              code: "NOT_ADMIN",
              message: `Role on '${newSlug}' is '${match.role}', not an admin role.`,
              suggestion: `Required: ${ADMIN_ROLES.join(", ")}.`,
              retriable: false,
            });
          }
          newTenant = match;
        }

        const claudePath = updateClaudeMcpEnv(SERVER_NAME, {
          FLOWLEARN_EMAIL: newEmail,
          FLOWLEARN_PASSWORD: newPassword,
          FLOWLEARN_TENANT_SLUG: newSlug,
        });

        updateEnvFile(ENV_FILE_PATH, {
          FLOWLEARN_EMAIL: newEmail,
          FLOWLEARN_PASSWORD: newPassword,
          FLOWLEARN_TENANT_SLUG: newSlug,
        });

        if (email) client.setEmail(newEmail);
        if (password) client.setPassword(newPassword);
        if (slug) client.setTenantSlug(newSlug);

        return entityResult({
          entity: {
            updated: {
              email: !!email,
              password: !!password,
              slug: !!slug,
            },
            active_tenant: newTenant,
            persisted_to: [claudePath, ENV_FILE_PATH],
            session_status:
              "In-memory config updated. Cached session cookie cleared if email/password changed; next tool call will sign in fresh.",
            restart_required: false,
          },
          summary: `Persisted updates: email=${!!email}, password=${!!password}, slug=${!!slug}. No restart required.`,
        });
      },
    },
  ];
}
