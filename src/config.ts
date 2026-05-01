import { z } from "zod";

export const FLOWLEARN_BASE_URL = "https://flowlearn.io";

const ConfigSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema> & {
  baseUrl: string;
};

export function loadConfig(): Config {
  const raw = {
    email: process.env.FLOWLEARN_EMAIL,
    password: process.env.FLOWLEARN_PASSWORD,
    tenantSlug: process.env.FLOWLEARN_TENANT_SLUG,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid flowlearn-mcp configuration. Required env vars:\n` +
        `  FLOWLEARN_EMAIL          tenant admin email\n` +
        `  FLOWLEARN_PASSWORD       tenant admin password\n` +
        `  FLOWLEARN_TENANT_SLUG    e.g. acme\n\n` +
        `Issues:\n${issues}`,
    );
  }

  return { ...parsed.data, baseUrl: FLOWLEARN_BASE_URL };
}
