import type { ToolsConfig } from '../config/schema.js';

export type AccessDecision = 'allowed' | 'blocked';

export function checkToolAccess(toolsConfig: ToolsConfig, toolName: string): AccessDecision {
  if (toolsConfig === '*') return 'allowed';

  if ('allow' in toolsConfig) {
    return toolsConfig.allow.includes(toolName) ? 'allowed' : 'blocked';
  }

  if ('block' in toolsConfig) {
    return toolsConfig.block.includes(toolName) ? 'blocked' : 'allowed';
  }

  return 'allowed';
}

export function filterAllowedTools(toolsConfig: ToolsConfig, toolNames: string[]): string[] {
  return toolNames.filter((name) => checkToolAccess(toolsConfig, name) === 'allowed');
}
