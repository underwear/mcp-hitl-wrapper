import { readFileSync } from 'node:fs';
import { ConfigSchema, type Config } from './schema.js';
import { getLogger } from '../utils/logger.js';

const ENV_PATTERN = /\$\{([^}]+)}/g;

export function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_PATTERN, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        getLogger('config').warn({ varName }, `Environment variable ${varName} is not set`);
        return match;
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const substituted = substituteEnvVars(parsed);
  return ConfigSchema.parse(substituted);
}

export function validateConfig(configPath: string): { valid: boolean; errors?: string[] } {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const substituted = substituteEnvVars(parsed);
    ConfigSchema.parse(substituted);
    return { valid: true };
  } catch (err) {
    if (err instanceof Error) {
      return { valid: false, errors: [err.message] };
    }
    return { valid: false, errors: ['Unknown error'] };
  }
}
