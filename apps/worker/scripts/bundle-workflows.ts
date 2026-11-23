import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';

const { code } = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
});
const out = fileURLToPath(new URL('../workflow-bundle.js', import.meta.url));
await writeFile(out, code);
console.log(`workflow bundle written to ${out} (${Math.round(code.length / 1024)} KB)`);
