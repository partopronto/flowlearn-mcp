import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowlearnClient } from "../client.js";
import { jsonResult, type ToolDef } from "./common.js";

const ADMIN_ROLES = ["tenant_admin", "creator", "super_admin"] as const;

type Membership = {
  tenant_id: string;
  slug: string;
  name: string;
  role: string;
};

// dist/tools/setup.js → dist/.. = package root
const PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENV_FILE_PATH = join(PACKAGE_ROOT, ".env");
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const SERVER_NAME = "flowlearn";

/**
 * Update or insert key=value lines in a .env file. Preserves comments and
 * unrelated keys. Creates the file if it doesn't exist.
 */
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

/**
 * Update env vars on the named MCP server entry in ~/.claude.json. Throws if
 * the server isn't registered. Returns the path written.
 */
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

/**
 * Validate a candidate (email, password) by attempting a sign-in against
 * Better Auth. Throws with a friendly message on failure. Does not mutate
 * any cookie cache — runs an isolated fetch.
 */
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
      name: "setup.status",
      description:
        "Diagnostic: returns the MCP's current configuration (signed-in email, " +
        "active tenant slug), the matching membership record, and all of the " +
        "user's admin-role tenants. Forces a fresh sign-in if the cached " +
        "session has expired. Use this to answer 'who am I and which tenant " +
        "am I currently acting on?'",
      inputSchema: {},
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

        return jsonResult({
          email: cfg.email,
          activeTenantSlug: cfg.tenantSlug,
          activeTenant: currentTenant,
          activeTenantIsAdmin: currentTenant
            ? (ADMIN_ROLES as readonly string[]).includes(currentTenant.role)
            : false,
          allAdminTenants: adminTenants,
          authConfirmed: true,
        });
      },
    },
    {
      name: "setup.switchTenant",
      description:
        "Switch which tenant the MCP acts on behalf of for the rest of this " +
        "Claude Code session. The change is IN-MEMORY ONLY and reverts when " +
        "Claude restarts. To make it permanent, use setup.update with the slug " +
        "field, or run `python scripts/register.py --slug <slug>` in terminal. " +
        "The new slug must belong to one of your admin-role tenants.",
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe("Slug of one of your admin-role tenants"),
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
          throw new Error(
            `'${newSlug}' is not one of your tenants. ` +
              `Available: ${available || "(none)"}.`,
          );
        }
        if (!(ADMIN_ROLES as readonly string[]).includes(match.role)) {
          throw new Error(
            `Your role on '${newSlug}' is '${match.role}', which is not an ` +
              `admin role. Required: ${ADMIN_ROLES.join(", ")}.`,
          );
        }

        client.setTenantSlug(newSlug);

        return jsonResult({
          switched: true,
          previousSlug,
          activeTenant: match,
          persistence: "in-memory only for this session",
          toPersist: `Call setup.update with {slug: "${newSlug}"} to make it permanent.`,
        });
      },
    },
    {
      name: "setup.update",
      description:
        "Persistently update one or more of email/password/tenant slug. " +
        "WARNING: passing a password as a tool argument means it goes into " +
        "this Claude Code chat transcript. Validates new credentials by " +
        "signing in fresh, then writes to BOTH ~/.claude.json (for future " +
        "Claude sessions) AND the package's .env file. The current MCP " +
        "process also picks up the new values immediately — no Claude " +
        "restart required. If validation fails, nothing is written.",
      inputSchema: {
        email: z.string().email().optional(),
        password: z.string().min(1).optional(),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe("Will be lowercased; must be an admin-role tenant"),
      },
      handler: async ({ email, password, slug }) => {
        if (!email && !password && !slug) {
          throw new Error(
            "Provide at least one of: email, password, slug.",
          );
        }

        const cfg = client.getConfig();
        const newEmail = (email as string | undefined) ?? cfg.email;
        const newPassword = (password as string | undefined) ?? cfg.password;
        const newSlug = slug
          ? String(slug).toLowerCase()
          : cfg.tenantSlug;

        // Step 1: validate the new (email, password) combo before touching
        // any persistence layer. If creds are bad, fail fast and leave the
        // existing setup intact.
        await validateCredentials(cfg.baseUrl, newEmail, newPassword);

        // Step 2: if slug is changing, validate it's one of the user's admin
        // tenants. We use the existing client (with old creds) to keep this
        // simple; sign-in with new creds happens below when we mutate the
        // in-memory config.
        let newTenant: Membership | null = null;
        if (slug) {
          const data = await client.request<{ memberships?: Membership[] }>(
            "/api/register/memberships",
          );
          const memberships = data.memberships ?? [];
          const match = memberships.find((m) => m.slug === newSlug);
          if (!match) {
            const available = memberships.map((m) => m.slug).join(", ");
            throw new Error(
              `Tenant slug '${newSlug}' not found in your memberships. ` +
                `Available: ${available || "(none)"}.`,
            );
          }
          if (!(ADMIN_ROLES as readonly string[]).includes(match.role)) {
            throw new Error(
              `Your role on '${newSlug}' is '${match.role}', not an admin ` +
                `role. Required: ${ADMIN_ROLES.join(", ")}.`,
            );
          }
          newTenant = match;
        }

        // Step 3: persist to ~/.claude.json (for future Claude sessions)
        const claudePath = updateClaudeMcpEnv(SERVER_NAME, {
          FLOWLEARN_EMAIL: newEmail,
          FLOWLEARN_PASSWORD: newPassword,
          FLOWLEARN_TENANT_SLUG: newSlug,
        });

        // Step 4: persist to .env (for register.py / tests)
        updateEnvFile(ENV_FILE_PATH, {
          FLOWLEARN_EMAIL: newEmail,
          FLOWLEARN_PASSWORD: newPassword,
          FLOWLEARN_TENANT_SLUG: newSlug,
        });

        // Step 5: in-memory update so the current session uses new values
        if (email) client.setEmail(newEmail);
        if (password) client.setPassword(newPassword);
        if (slug) client.setTenantSlug(newSlug);

        return jsonResult({
          updated: {
            email: !!email,
            password: !!password,
            slug: !!slug,
          },
          activeTenant: newTenant,
          persistedTo: [claudePath, ENV_FILE_PATH],
          sessionStatus:
            "In-memory config updated. The cached session cookie is " +
            "cleared if email/password changed; the next tool call will " +
            "trigger a fresh sign-in.",
          restartRequired: false,
        });
      },
    },
  ];
}
