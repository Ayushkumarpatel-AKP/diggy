import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Resolve the repository root from this config file's location
 * (`<repo>/apps/demo/vite.config.ts` → `<repo>`), without depending on Node
 * typings. On Windows a leading `/C:` is stripped.
 */
function repoRoot(): string {
  const pathname = decodeURIComponent(new URL('../../', import.meta.url).pathname);
  return pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Keep a single copy of three across the workspace packages.
    dedupe: ['three'],
  },
  server: {
    port: 5173,
    // Allow serving files (e.g. .vrm models) from anywhere inside the repo.
    fs: {
      allow: [repoRoot()],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
