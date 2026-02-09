import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: true,
    dts: true,
    sourcemap: true,
    splitting: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/server.ts'],
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: false,
    dts: true,
    sourcemap: true,
    splitting: true,
  },
]);
