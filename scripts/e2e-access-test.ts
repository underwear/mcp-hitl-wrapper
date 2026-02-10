#!/usr/bin/env tsx
/**
 * E2E access control test — tests block list and tool filtering
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' Access Control E2E Tests');
  console.log('═══════════════════════════════════════════════\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js', 'serve', '--config', 'config/test-block.json'],
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client(
    { name: 'access-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  await new Promise(r => setTimeout(r, 3000));

  // TEST: List tools should not include blocked tools
  console.log('📋 TEST: Tool listing with block list');
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    if (!names.includes('jira__jira_delete')) {
      ok('block:jira_delete', 'Not in tool list');
    } else {
      fail('block:jira_delete', 'Should not be in tool list');
    }

    if (!names.includes('jira__jira_put')) {
      ok('block:jira_put', 'Not in tool list');
    } else {
      fail('block:jira_put', 'Should not be in tool list');
    }

    if (names.includes('jira__jira_get')) {
      ok('allowed:jira_get', 'In tool list');
    } else {
      fail('allowed:jira_get', 'Should be in tool list');
    }

    if (names.includes('jira__jira_post')) {
      ok('allowed:jira_post', 'In tool list');
    } else {
      fail('allowed:jira_post', 'Should be in tool list');
    }

    if (names.includes('jira__jira_patch')) {
      ok('allowed:jira_patch', 'In tool list');
    } else {
      fail('allowed:jira_patch', 'Should be in tool list');
    }

    console.log(`  Exposed tools: ${names.join(', ')}`);
  } catch (err) {
    fail('list_tools', err);
  }

  // TEST: Calling blocked tool should error
  console.log('\n🚫 TEST: Call blocked tool (jira_delete)');
  try {
    const result = await client.callTool({
      name: 'jira__jira_delete',
      arguments: { path: '/rest/api/3/issue/FAKE-1' },
    });
    if (result.isError) {
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      if (text.includes('blocked')) {
        ok('call_blocked', `Correctly blocked: ${text}`);
      } else {
        fail('call_blocked', `Error but not blocked: ${text}`);
      }
    } else {
      fail('call_blocked', 'Should have been blocked');
    }
  } catch (err) {
    fail('call_blocked', err);
  }

  // TEST: Allowed passthrough tool works
  console.log('\n🔓 TEST: Call allowed passthrough tool (jira_get)');
  try {
    const result = await client.callTool({
      name: 'jira__jira_get',
      arguments: { path: '/rest/api/3/myself' },
    });
    if (!result.isError) {
      ok('call_allowed', 'Passthrough succeeded');
    } else {
      fail('call_allowed', `Unexpected error: ${(result.content[0] as { type: 'text'; text: string }).text}`);
    }
  } catch (err) {
    fail('call_allowed', err);
  }

  // TEST: Allowed PATCH (not blocked) should work
  console.log('\n🔓 TEST: Call allowed tool (jira_patch — not in block list)');
  try {
    const result = await client.callTool({
      name: 'jira__jira_patch',
      arguments: { path: '/rest/api/3/myself', body: {} },
    });
    // We expect this to fail at Jira level (can't patch yourself), but not blocked
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    if (text.includes('blocked')) {
      fail('patch_not_blocked', 'Should not be blocked');
    } else {
      ok('patch_not_blocked', 'Not blocked by access control (may error at Jira level)');
    }
  } catch (err) {
    fail('patch_not_blocked', err);
  }

  await client.close();

  console.log('\n═══════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main();
