#!/usr/bin/env tsx
/**
 * E2E reject flow test — press REJECT in Telegram when prompted
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
  console.log(' HITL Reject Flow E2E Test');
  console.log(' >>> PRESS REJECT IN TELEGRAM <<<');
  console.log('═══════════════════════════════════════════════\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/cli.js', 'serve', '--config', 'config/test-e2e.json'],
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client(
    { name: 'reject-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  await new Promise(r => setTimeout(r, 3000));

  // TEST 1: Reject flow
  console.log('🔴 TEST 1: HITL reject (jira_post) — PRESS REJECT IN TELEGRAM');
  try {
    const result = await client.callTool({
      name: 'jira__jira_post',
      arguments: {
        path: '/rest/api/3/search/jql',
        body: { jql: 'project IS NOT EMPTY', maxResults: 1 },
        _agent: 'reject-test',
        _reason: 'Testing REJECT flow — press Reject!',
      },
    }, undefined, { timeout: 240_000 });

    const text = (result.content[0] as { type: 'text'; text: string }).text;

    if (result.isError && text.includes('rejected')) {
      ok('reject', `Correctly rejected: ${text}`);
    } else if (result.isError && text.includes('timed out')) {
      fail('reject', 'Timed out — you needed to press Reject button');
    } else if (!result.isError) {
      fail('reject', 'Was approved instead of rejected — press Reject next time!');
    } else {
      fail('reject', `Unexpected: ${text}`);
    }
  } catch (err) {
    fail('reject', err);
  }

  // TEST 2: Verify audit shows rejection
  console.log('\n📊 TEST 2: Verify audit log has rejection');
  try {
    const { execSync } = await import('node:child_process');

    // Close client first so audit is written
    await client.close();
    await new Promise(r => setTimeout(r, 1000));

    const output = execSync(
      'node dist/cli.js audit list --tool jira_post --last 1 --config config/test-e2e.json',
      { env: { ...process.env }, encoding: 'utf-8', timeout: 10000 },
    );

    if (output.includes('rejected')) {
      ok('audit:rejected', 'Rejection recorded in audit log');
      console.log(`  ${output.trim().split('\n').filter(l => l.includes('rejected')).join('\n  ')}`);
    } else {
      fail('audit:rejected', `No rejection in audit: ${output.substring(0, 200)}`);
    }
  } catch (err) {
    fail('audit:rejected', err);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main();
