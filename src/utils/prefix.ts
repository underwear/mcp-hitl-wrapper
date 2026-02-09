const SEPARATOR = '__';

export function prefixToolName(mcpName: string, toolName: string): string {
  return `${mcpName}${SEPARATOR}${toolName}`;
}

export function unprefixToolName(prefixedName: string): { mcpName: string; toolName: string } | null {
  const idx = prefixedName.indexOf(SEPARATOR);
  if (idx === -1) return null;
  return {
    mcpName: prefixedName.substring(0, idx),
    toolName: prefixedName.substring(idx + SEPARATOR.length),
  };
}

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const [, value, unit] = match;
  const num = parseInt(value, 10);
  switch (unit) {
    case 'ms': return num;
    case 's': return num * 1000;
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}
