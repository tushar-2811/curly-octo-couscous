import { defineConfig } from 'tsup';

// Bundle our workspace packages into the output; leave npm dependencies external.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@aiw\//],
});
