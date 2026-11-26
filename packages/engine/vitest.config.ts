import { defineConfig } from 'vitest/config';

// Tests share one real database; run files one at a time so a migration revert in one
// file never races inserts in another.
export default defineConfig({ test: { fileParallelism: false } });
