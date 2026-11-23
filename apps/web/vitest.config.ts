import { defineConfig } from 'vitest/config';

// API tests share one real database; run files one at a time.
export default defineConfig({ test: { fileParallelism: false } });
