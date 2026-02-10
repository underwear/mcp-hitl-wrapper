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

export function parseDuration(duration: string, minMs = 0): number {
  const match = duration.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const [, value, unit] = match;
  const num = parseInt(value, 10);
  let ms: number;
  switch (unit) {
    case 'ms': ms = num; break;
    case 's': ms = num * 1000; break;
    case 'm': ms = num * 60 * 1000; break;
    case 'h': ms = num * 60 * 60 * 1000; break;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
  if (ms < minMs) throw new Error(`Duration ${duration} is less than minimum ${minMs}ms`);
  return ms;
}
