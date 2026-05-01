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
import type { ToolDef } from "./tools/common.js";
import { buildCourseTools } from "./tools/course.js";
import { buildModuleTools } from "./tools/module.js";
import { buildLessonTools } from "./tools/lesson.js";
import { buildFlowStepTools } from "./tools/flowStep.js";
import { buildConnectionTools } from "./tools/connection.js";
import { buildSetupTools } from "./tools/setup.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new FlowlearnClient(config);

  const tools: ToolDef[] = [
    ...buildSetupTools(client),
    ...buildCourseTools(client),
    ...buildModuleTools(client),
    ...buildLessonTools(client),
    ...buildFlowStepTools(client),
    ...buildConnectionTools(client),
  ];

  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "flowlearn-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(z.object(t.inputSchema), {
        $refStrategy: "none",
        target: "jsonSchema7",
      }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }

    const parsed = z
      .object(tool.inputSchema)
      .safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [
          {
            type: "text",
            text:
              `Invalid arguments for ${tool.name}:\n` +
              parsed.error.issues
                .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("\n"),
          },
        ],
        isError: true,
      };
    }

    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      const message =
        err instanceof FlowlearnApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `flowlearn-mcp ready: ${tools.length} tools, tenant=${config.tenantSlug}, base=${config.baseUrl}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`flowlearn-mcp failed to start: ${err.message ?? err}\n`);
  process.exit(1);
});
