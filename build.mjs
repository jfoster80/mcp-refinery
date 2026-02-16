/**
 * Bundle MCP Refinery into a single portable JS file.
 * Run: node build.mjs
 * Output: dist/mcp-refinery.cjs
 *
 * For a standalone exe, use: npx pkg dist/mcp-refinery.cjs
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/mcp-refinery.cjs',
  format: 'cjs',
  minify: false,
  sourcemap: true,
  external: [],
  banner: { js: '#!/usr/bin/env node' },
});

console.log('Bundled to dist/mcp-refinery.cjs');
