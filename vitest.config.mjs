import { defineConfig } from 'vitest/config';

// The only test surface in this repo is the AI review coverage gate (EHAC-2057).
// Node environment: the gate modules are Node-built-ins-only ESM and several specs
// exercise the CLIs through `spawnSync`, so a DOM environment would be misleading.
export default defineConfig({
  test: {
    include: ['scripts/ai-review-coverage/*.test.mjs'],
    environment: 'node',
  },
});
