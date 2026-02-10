import { z } from 'zod';

const durationPattern = /^\d+(ms|s|m|h)$/;

const DurationSchema = z.string().regex(durationPattern, 'Invalid duration format (e.g. "3m", "30s", "1h")');

const TelegramDestinationSchema = z.object({
  driver: z.literal('telegram').default('telegram'),
  botToken: z.string().min(1),
  chatId: z.union([z.string().min(1), z.number()]).transform(String),
});

const DestinationSchema = z.discriminatedUnion('driver', [
  TelegramDestinationSchema,
]);

const ToolsConfigSchema = z.union([
  z.literal('*'),
  z.object({ allow: z.array(z.string().min(1)) }),
  z.object({ block: z.array(z.string().min(1)) }),
]);

const DiscoveryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  pollInterval: DurationSchema.default('3h'),
  notifications: z.object({
    newTools: z.enum(['log', 'telegram', 'both', 'none']).default('log'),
  }).default({}),
}).default({ enabled: false });

const StdioMcpSchema = z.object({
  transport: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  tools: ToolsConfigSchema.default('*'),
  discovery: DiscoveryConfigSchema,
});

const SseMcpSchema = z.object({
  transport: z.literal('sse').optional(),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  tools: ToolsConfigSchema.default('*'),
  discovery: DiscoveryConfigSchema,
});

const StreamableHttpMcpSchema = z.object({
  transport: z.literal('streamable-http'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  tools: ToolsConfigSchema.default('*'),
  discovery: DiscoveryConfigSchema,
});

// Pre-process to infer transport before union validation
const McpConfigSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !('transport' in val && (val as Record<string, unknown>).transport)) {
    const obj = val as Record<string, unknown>;
    if ('command' in obj) return { ...obj, transport: 'stdio' };
    if ('url' in obj) return { ...obj, transport: 'sse' };
  }
  return val;
}, z.union([StdioMcpSchema, SseMcpSchema, StreamableHttpMcpSchema]));

const HitlToolConfigSchema = z.object({
  timeout: DurationSchema.optional(),
  destination: z.string().optional(),
});

const HitlConfigSchema = z.object({
  defaultDestination: z.string().default('default'),
  defaultTimeout: DurationSchema.default('3m'),
  tools: z.record(z.string(), z.record(z.string(), HitlToolConfigSchema)).default({}),
});

const AuditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default('./data/audit.db'),
  retentionDays: z.number().int().positive().default(90),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
});

const McpNameSchema = z.string().min(1).refine(
  (name) => !name.includes('__'),
  { message: 'MCP name must not contain "__" (double underscore) — it is used as a tool name separator' },
);

export const ConfigSchema = z.object({
  server: z.object({
    name: z.string().default('mcp-hitl-wrapper'),
    version: z.string().default('1.0.0'),
  }).default({}),
  destinations: z.record(z.string(), DestinationSchema).default({}),
  mcps: z.record(McpNameSchema, McpConfigSchema),
  hitl: HitlConfigSchema.default({}),
  audit: AuditConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
}).superRefine((data, ctx) => {
  // Cross-validate: HITL destination references must exist in destinations
  const destNames = new Set(Object.keys(data.destinations));

  if (data.hitl.defaultDestination && destNames.size > 0 && !destNames.has(data.hitl.defaultDestination)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `HITL defaultDestination "${data.hitl.defaultDestination}" not found in destinations`,
      path: ['hitl', 'defaultDestination'],
    });
  }

  for (const [mcpName, tools] of Object.entries(data.hitl.tools)) {
    for (const [toolName, toolConfig] of Object.entries(tools)) {
      if (toolConfig.destination && !destNames.has(toolConfig.destination)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `HITL destination "${toolConfig.destination}" for ${mcpName}.${toolName} not found in destinations`,
          path: ['hitl', 'tools', mcpName, toolName, 'destination'],
        });
      }
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type StdioMcpConfig = z.infer<typeof StdioMcpSchema>;
export type SseMcpConfig = z.infer<typeof SseMcpSchema>;
export type StreamableHttpMcpConfig = z.infer<typeof StreamableHttpMcpSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type HitlToolConfig = z.infer<typeof HitlToolConfigSchema>;
export type DestinationConfig = z.infer<typeof DestinationSchema>;
export type TelegramDestinationConfig = z.infer<typeof TelegramDestinationSchema>;
