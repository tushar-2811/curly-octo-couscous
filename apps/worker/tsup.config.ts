import { defineConfig } from 'tsup';

// Workflow code is bundled separately by Temporal (scripts/bundle-workflows.ts) because it
// runs in Temporal's deterministic sandbox; this bundle is the worker process itself.
export default defineConfig({
  entry: ['src/worker.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@aiw\//],
});
