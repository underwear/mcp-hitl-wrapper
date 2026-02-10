import { program } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, validateConfig } from './config/loader.js';
import { HitlWrapperServer } from './server.js';
import { AuditDb } from './audit/db.js';
import { UpstreamManager } from './mcp/upstream.js';
import { DiscoveryService } from './mcp/discovery.js';
import { checkToolAccess } from './mcp/access.js';
import { getLogger } from './utils/logger.js';

const log = getLogger('cli');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

program
  .name('mcp-hitl')
  .description('Universal MCP proxy with Human-in-the-Loop approval flow')
  .version(pkg.version);

// serve
program
  .command('serve')
  .description('Start the MCP HITL wrapper server')
  .option('-c, --config <path>', 'Path to config file', 'config.json')
  .action(async (opts) => {
    const configPath = resolve(opts.config);
    const config = loadConfig(configPath);
    const server = new HitlWrapperServer(config);

    // BUG 28: Guard against double shutdown
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal }, 'Received shutdown signal');
      try {
        await server.stop();
      } catch (err) {
        // BUG 27: Handle shutdown errors
        log.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await server.start();
  });

// validate
program
  .command('validate')
  .description('Validate a config file')
  .argument('<config>', 'Path to config file')
  .action((configFile) => {
    const configPath = resolve(configFile);
    const result = validateConfig(configPath);
    if (result.valid) {
      console.log('✅ Config is valid');
    } else {
      console.error('❌ Config is invalid:');
      for (const err of result.errors ?? []) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
  });

// discover
program
  .command('discover')
  .description('Discover all tools from upstream MCPs')
  .option('-c, --config <path>', 'Path to config file', 'config.json')
  .action(async (opts) => {
    const configPath = resolve(opts.config);
    const config = loadConfig(configPath);
    const upstream = new UpstreamManager();

    try {
      await upstream.connect(config);
      const discovery = new DiscoveryService(upstream, config);
      const tools = await discovery.discoverAll();

      for (const [mcpName, toolNames] of tools) {
        console.log(`\n📦 ${mcpName} (${toolNames.length} tools):`);
        for (const name of toolNames) {
          const mcpConfig = config.mcps[mcpName];
          const access = checkToolAccess(mcpConfig.tools, name);
          const hitl = config.hitl.tools[mcpName]?.[name] ? ' 🔔 HITL' : '';
          const icon = access === 'blocked' ? '🚫' : '✅';
          console.log(`  ${icon} ${name}${hitl}`);
        }
      }
    } finally {
      await upstream.close();
    }
  });

// diff
program
  .command('diff')
  .description('Show tool status diff vs config')
  .option('-c, --config <path>', 'Path to config file', 'config.json')
  .action(async (opts) => {
    const configPath = resolve(opts.config);
    const config = loadConfig(configPath);
    const upstream = new UpstreamManager();

    try {
      await upstream.connect(config);
      const discovery = new DiscoveryService(upstream, config);
      const diff = await discovery.diff();

      for (const [mcpName, status] of diff) {
        console.log(`\n📦 ${mcpName}:`);
        console.log(`  ✅ Allowed: ${status.allowed.length}`);
        for (const t of status.allowed) {
          const hitl = status.hitl.includes(t) ? ' 🔔' : '';
          console.log(`     ${t}${hitl}`);
        }
        if (status.blocked.length > 0) {
          console.log(`  🚫 Blocked: ${status.blocked.length}`);
          for (const t of status.blocked) {
            console.log(`     ${t}`);
          }
        }
        if (status.hitl.length > 0) {
          console.log(`  🔔 HITL: ${status.hitl.join(', ')}`);
        }
      }
    } finally {
      await upstream.close();
    }
  });

// audit
const auditCmd = program
  .command('audit')
  .description('Query audit log');

auditCmd
  .command('list')
  .description('List audit log entries')
  .option('-c, --config <path>', 'Path to config file', 'config.json')
  .option('-n, --last <n>', 'Show last N entries', '20')
  .option('-t, --tool <name>', 'Filter by tool name')
  .option('-m, --mcp <name>', 'Filter by MCP name')
  .option('--since <duration>', 'Show entries since duration (e.g. 1h, 7d, 30m)')
  .action((opts) => {
    const configPath = resolve(opts.config);
    const config = loadConfig(configPath);
    const db = new AuditDb(config.audit.dbPath);

    try {
      let since: string | undefined;
      if (opts.since) {
        // BUG 13: Validate --since format and error on invalid
        const match = opts.since.match(/^(\d+)(m|h|d)$/);
        if (!match) {
          console.error(`❌ Invalid --since format: "${opts.since}" (expected e.g. "1h", "7d", "30m")`);
          process.exit(1);
        }
        const [, value, unit] = match;
        const ms = parseInt(value) * (unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 60000);
        since = new Date(Date.now() - ms).toISOString();
      }

      // BUG 24: Validate --last
      const last = parseInt(opts.last);
      if (isNaN(last) || last <= 0) {
        console.error(`❌ Invalid --last value: "${opts.last}" (expected positive integer)`);
        process.exit(1);
      }

      const records = db.query({
        last,
        tool: opts.tool,
        mcp: opts.mcp,
        since,
      });

      if (records.length === 0) {
        console.log('No audit records found');
        return;
      }

      console.log(`\n📋 Audit Log (${records.length} entries):\n`);
      for (const r of records) {
        const icon = r.decision === 'approved' ? '✅' :
                     r.decision === 'rejected' ? '❌' :
                     r.decision === 'timeout' ? '⏱' :
                     r.decision === 'blocked' ? '🚫' : '➡️';
        console.log(`${icon} [${r.timestamp}] ${r.mcp}.${r.tool} → ${r.decision} (${r.decided_by}, ${r.latency_ms}ms)`);
        if (r.agent) console.log(`   Agent: ${r.agent}`);
        if (r.reason) console.log(`   Reason: ${r.reason}`);
      }
    } finally {
      db.close();
    }
  });

auditCmd
  .command('export')
  .description('Export audit log')
  .option('-c, --config <path>', 'Path to config file', 'config.json')
  .option('-f, --format <format>', 'Export format (csv|json)', 'json')
  .option('-o, --output <file>', 'Output file (stdout if omitted)')
  .action((opts) => {
    const configPath = resolve(opts.config);
    const config = loadConfig(configPath);
    const db = new AuditDb(config.audit.dbPath);

    try {
      const records = db.exportAll();

      let output: string;
      if (opts.format === 'csv') {
        const headers = ['id', 'timestamp', 'agent', 'mcp', 'tool', 'params', 'reason', 'content', 'decision', 'decided_by', 'latency_ms'];
        const rows = records.map(r =>
          headers.map(h => {
            const val = r[h as keyof typeof r];
            const str = val === null || val === undefined ? '' : String(val);
            // BUG 12: Also quote strings containing newlines
            return str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')
              ? `"${str.replace(/"/g, '""')}"` : str;
          }).join(',')
        );
        output = [headers.join(','), ...rows].join('\n');
      } else {
        output = JSON.stringify(records, null, 2);
      }

      if (opts.output) {
        writeFileSync(resolve(opts.output), output);
        console.log(`✅ Exported ${records.length} records to ${opts.output}`);
      } else {
        console.log(output);
      }
    } finally {
      db.close();
    }
  });

program.parse();
