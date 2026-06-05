import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Only pick up tests we own — avoids pre-existing failures in ._archive and open-sse
    include: ['src/__tests__/**/*.test.{js,ts}'],
    exclude: ['._archive/**', 'node_modules/**'],
    // Isolate each test file to prevent global state leaking between suites
    isolate: true,
  },
  resolve: {
    alias: {
      // Match the @/ alias Next.js uses for ./src
      '@': path.resolve(__dirname, './src'),
    },
  },
});
