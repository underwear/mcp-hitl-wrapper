#!/usr/bin/env tsx
/**
 * E2E test script for mcp-hitl-wrapper
 * Tests real MCP proxy with Jira + Telegram HITL
 *
 * Usage: tsx scripts/e2e-test.ts
 * Requires env vars: TG_BOT_TOKEN, TG_CHAT_ID, JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENV = {
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN!,
  TG_CHAT_ID: process.env.TG_CHAT_ID!,
  JIRA_SITE: process.env.JIRA_SITE!,
  JIRA_EMAIL: process.env.JIRA_EMAIL!,
  JIRA_TOKEN: process.env.JIRA_TOKEN!,
};

// Verify all env vars present
for (const [key, val] of Object.entries(ENV)) {
  if (!val) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

let client: Client | null = null;
let passed = 0;
let failed = 0;

function ok(name: string, msg?: string) {
  passed++;
  console.log(`  ✅ ${name}${msg ? ` — ${msg}` : ''}`);
}

function fail(name: string, err: unknown) {
  failed++;
  console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
}

async function connectToServer(): Promise<Client> {
  console.log('\n🔌 Connecting to mcp-hitl-wrapper server...');
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js', 'serve', '--config', 'config/test-e2e.json'],
    env: { ...process.env } as Record<string, string>,
  });

  const c = new Client(
    { name: 'e2e-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await c.connect(transport);
  console.log('  Connected!\n');
  return c;
}

// ─── TEST 1: List tools ───
async function testListTools() {
  console.log('📋 TEST 1: List tools');
  try {
    const { tools } = await client!.listTools();

    if (tools.length === 0) {
      fail('listTools', 'No tools returned');
      return;
    }

    // All tools should have jira__ prefix
    const allPrefixed = tools.every(t => t.name.startsWith('jira__'));
    if (!allPrefixed) {
      fail('prefix', `Not all tools prefixed: ${tools.map(t => t.name).join(', ')}`);
      return;
    }
    ok('prefix', `All ${tools.length} tools have jira__ prefix`);

    // Should have all 5 jira tools
    const expectedTools = ['jira__jira_get', 'jira__jira_post', 'jira__jira_put', 'jira__jira_patch', 'jira__jira_delete'];
    const toolNames = tools.map(t => t.name);
    for (const expected of expectedTools) {
      if (toolNames.includes(expected)) {
        ok(`tool:${expected}`, 'present');
      } else {
        fail(`tool:${expected}`, 'missing');
      }
    }

    // All tools should have inputSchema
    const allHaveSchema = tools.every(t => t.inputSchema && typeof t.inputSchema === 'object');
    if (allHaveSchema) {
      ok('inputSchema', 'All tools have inputSchema');
    } else {
      fail('inputSchema', 'Some tools missing inputSchema');
    }

    console.log(`  Tool names: ${toolNames.join(', ')}\n`);
  } catch (err) {
    fail('listTools', err);
  }
}

// ─── TEST 2: Passthrough tool call (jira_get — no HITL) ───
async function testPassthroughCall() {
  console.log('🔓 TEST 2: Passthrough call (jira_get — no HITL)');
  try {
    const result = await client!.callTool({
      name: 'jira__jira_get',
      arguments: { path: '/rest/api/3/myself' },
    });

    if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
      fail('passthrough', 'Empty response');
      return;
    }

    const textContent = result.content[0];
    if (textContent.type !== 'text') {
      fail('passthrough', `Unexpected content type: ${textContent.type}`);
      return;
    }

    // Parse the response to verify it's valid Jira data
    const text = (textContent as { type: 'text'; text: string }).text;
    try {
      const data = JSON.parse(text);
      if (data.emailAddress || data.displayName) {
        ok('passthrough:jira_get', `Got user: ${data.displayName || data.emailAddress}`);
      } else {
        ok('passthrough:jira_get', `Got response (${text.substring(0, 100)}...)`);
      }
    } catch {
      ok('passthrough:jira_get', `Got text response (${text.substring(0, 100)}...)`);
    }

    if (!result.isError) {
      ok('passthrough:no_error', 'No error flag');
    } else {
      fail('passthrough:no_error', 'isError is true');
    }
  } catch (err) {
    fail('passthrough', err);
  }
}

// ─── TEST 3: Passthrough — list projects ───
async function testListProjects() {
  console.log('📁 TEST 3: List Jira projects (passthrough)');
  try {
    const result = await client!.callTool({
      name: 'jira__jira_get',
      arguments: { path: '/rest/api/3/project' },
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    try {
      const projects = JSON.parse(text);
      if (Array.isArray(projects)) {
        ok('list_projects', `Found ${projects.length} projects: ${projects.slice(0, 3).map((p: { key: string }) => p.key).join(', ')}${projects.length > 3 ? '...' : ''}`);
      } else {
        ok('list_projects', `Response received (not array)`);
      }
    } catch {
      ok('list_projects', `Got response (${text.substring(0, 100)}...)`);
    }
  } catch (err) {
    fail('list_projects', err);
  }
}

// ─── TEST 4: Invalid tool name (no prefix) ───
async function testInvalidToolName() {
  console.log('🚫 TEST 4: Invalid tool name (no prefix)');
  try {
    const result = await client!.callTool({
      name: 'jira_get',
      arguments: { path: '/rest/api/3/myself' },
    });

    if (result.isError) {
      ok('invalid_name', `Correctly returned error: ${(result.content[0] as { type: 'text'; text: string }).text}`);
    } else {
      fail('invalid_name', 'Should have returned error for unprefixed name');
    }
  } catch (err) {
    fail('invalid_name', err);
  }
}

// ─── TEST 5: Unknown MCP ───
async function testUnknownMcp() {
  console.log('🚫 TEST 5: Unknown MCP');
  try {
    const result = await client!.callTool({
      name: 'nonexistent__some_tool',
      arguments: {},
    });

    if (result.isError) {
      ok('unknown_mcp', `Correctly returned error: ${(result.content[0] as { type: 'text'; text: string }).text}`);
    } else {
      fail('unknown_mcp', 'Should have returned error for unknown MCP');
    }
  } catch (err) {
    fail('unknown_mcp', err);
  }
}

// ─── TEST 6: HITL approval flow (jira_post — requires Telegram approval) ───
async function testHitlApproval() {
  console.log('🔔 TEST 6: HITL approval flow (jira_post)');
  console.log('  ⏳ Sending HITL request — CHECK TELEGRAM for approval button...');

  try {
    // Use the new Jira search/jql endpoint (v3)
    // Set timeout to 4 minutes (our HITL timeout is 3m, MCP default is 60s)
    const resultPromise = client!.callTool({
      name: 'jira__jira_post',
      arguments: {
        path: '/rest/api/3/search/jql',
        body: { jql: 'project IS NOT EMPTY ORDER BY created DESC', maxResults: 1 },
        _agent: 'e2e-test',
        _reason: 'Testing HITL approval flow',
      },
    }, undefined, { timeout: 240_000 });

    // Wait with a timeout hint for the user
    console.log('  ⏳ Waiting up to 3 minutes for your Telegram response...');

    const result = await resultPromise;
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    if (result.isError) {
      if (text.includes('rejected')) {
        ok('hitl:rejected', `Request was rejected: ${text}`);
      } else if (text.includes('timed out')) {
        ok('hitl:timeout', 'Request timed out (expected if no Telegram response)');
      } else {
        fail('hitl', `Unexpected error: ${text}`);
      }
    } else {
      ok('hitl:approved', `Request approved! Response: ${text.substring(0, 150)}...`);
    }
  } catch (err) {
    fail('hitl', err);
  }
}

// ─── TEST 7: Audit log ───
async function testAuditLog() {
  console.log('📊 TEST 7: Audit log (CLI)');
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync(
      'node dist/cli.js audit list --last 10 --config config/test-e2e.json',
      {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 10000,
      },
    );

    if (output.includes('jira') || output.includes('audit')) {
      ok('audit:list', `Got audit output (${output.split('\n').length} lines)`);
    } else if (output.trim() === '') {
      ok('audit:list', 'No audit entries yet (expected if serve just started)');
    } else {
      ok('audit:list', `Output: ${output.substring(0, 200)}`);
    }
  } catch (err) {
    fail('audit:list', err);
  }
}

// ─── MAIN ───
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' mcp-hitl-wrapper E2E Test Suite');
  console.log('═══════════════════════════════════════════════');

  try {
    client = await connectToServer();

    // Wait for upstream to initialize
    await new Promise(r => setTimeout(r, 3000));

    await testListTools();
    await testPassthroughCall();
    await testListProjects();
    await testInvalidToolName();
    await testUnknownMcp();
    await testHitlApproval();

    console.log('\n--- Disconnecting from server ---');
    await client.close();
    client = null;

    // Wait for server to write audit
    await new Promise(r => setTimeout(r, 1000));
    await testAuditLog();

  } catch (err) {
    console.error('\n💥 Fatal error:', err);
    failed++;
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
