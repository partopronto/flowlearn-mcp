#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadConfig } from "./config.js";
import { FlowlearnClient, FlowlearnApiError } from "./client.js";
import { errorResult, type ToolDef } from "./tools/common.js";
import { buildCourseTools } from "./tools/course.js";
import { buildModuleTools } from "./tools/module.js";
import { buildLessonTools } from "./tools/lesson.js";
import { buildFlowStepTools } from "./tools/flowStep.js";
import { buildConnectionTools } from "./tools/connection.js";
import { buildSetupTools } from "./tools/setup.js";
import { buildHelpTools } from "./tools/help.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new FlowlearnClient(config);

  const tools: ToolDef[] = [
    ...buildHelpTools(),
    ...buildSetupTools(client),
    ...buildCourseTools(client),
    ...buildModuleTools(client),
    ...buildLessonTools(client),
    ...buildFlowStepTools(client),
    ...buildConnectionTools(client),
  ];

  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "flowlearn-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => {
      const inputSchema = zodToJsonSchema(z.object(t.inputSchema), {
        $refStrategy: "none",
        target: "jsonSchema7",
      }) as Record<string, unknown>;
      const outputSchema = t.outputSchema
        ? (zodToJsonSchema(t.outputSchema, {
            $refStrategy: "none",
            target: "jsonSchema7",
          }) as Record<string, unknown>)
        : undefined;
      return {
        name: t.name,
        description: t.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return errorResult({
        code: "UNKNOWN_TOOL",
        message: `Unknown tool: ${req.params.name}`,
        suggestion:
          "Call ListTools to discover the current tool catalog. Tool names changed in v0.2.0 — old dotted names like 'course.list' are now 'flowlearn_course_list'.",
        retriable: false,
      });
    }

    const parsed = z
      .object(tool.inputSchema)
      .safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult({
        code: "INVALID_ARGUMENTS",
        message: `Invalid arguments for ${tool.name}`,
        suggestion:
          "Re-read the tool's inputSchema and resubmit. See `details.issues` for each violation.",
        retriable: true,
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join(".") || "(root)",
            message: i.message,
            code: i.code,
          })),
        },
      });
    }

    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      if (err instanceof FlowlearnApiError) {
        return errorResult({
          code: `FLOWLEARN_API_${err.status}`,
          message: err.message,
          suggestion:
            err.status === 401
              ? "Auth failed despite a refresh attempt. Verify FLOWLEARN_EMAIL/PASSWORD and tenant membership."
              : err.status === 403
                ? "Active tenant likely doesn't grant the required role for this op. Call flowlearn_setup_status."
                : err.status === 404
                  ? "Entity not found. Call the matching list tool to verify the id exists."
                  : err.status >= 500
                    ? "Upstream Flowlearn error. Retrying may help."
                    : undefined,
          retriable: err.status >= 500 || err.status === 401,
          details: { status: err.status, path: err.path, body: err.body },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return errorResult({
        code: "INTERNAL_ERROR",
        message,
        retriable: false,
      });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `flowlearn-mcp v0.2.0 ready: ${tools.length} tools, tenant=${config.tenantSlug}, base=${config.baseUrl}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`flowlearn-mcp failed to start: ${err.message ?? err}\n`);
  process.exit(1);
});
