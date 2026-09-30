import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // Vitest 4 runs on Vite 8: configure its Oxc/Rolldown JSX transforms directly.
  // The production Vite 6 build keeps @vitejs/plugin-react in vite.config.ts.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  optimizeDeps: {
    rolldownOptions: {
      transform: { jsx: { runtime: 'automatic' } },
    },
  },
  test: {
    globals: true,
    // Use happy-dom instead of jsdom to avoid ESM compatibility issues.
    // jsdom's dependency chain (html-encoding-sniffer -> @exodus/bytes) uses
    // ESM-only modules that fail with "require() of ES Module not supported".
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    // The CI gate runs beside the browser/pdf/backend gates on 4 vCPUs. The 5s/10s defaults
    // read CPU contention as a failing test; these limits only stop that false alarm.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'functions/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'src/test', 'e2e', '**/*.d.ts'],
    },
    // Handle ESM-only dependencies that may cause require() errors
    deps: {
      optimizer: {
        web: {
          include: ['@exodus/bytes', 'html-encoding-sniffer'],
        },
      },
    },
  },
  resolve: {
    alias: {
      // vite-plugin-pwa synthesises this only during a production build; without
      // a stub, every file importing it fails to load under vitest.
      'virtual:pwa-register': path.resolve(__dirname, './src/test/stubs/pwa-register.ts'),
      '@': path.resolve(__dirname, './src'),
      '@almamesh/shared-types': path.resolve(__dirname, '../../packages/shared-types/src'),
      '@almamesh/constants': path.resolve(__dirname, '../../packages/constants/src'),
      '@almamesh/store': path.resolve(__dirname, '../../packages/store/src'),
      '@almamesh/llm': path.resolve(__dirname, '../../packages/llm/src'),
      '@almamesh/memory': path.resolve(__dirname, '../../packages/memory/src'),
      '@almamesh/browser/types': path.resolve(__dirname, '../../packages/browser/src/types'),
      '@almamesh/browser': path.resolve(__dirname, '../../packages/browser/src'),
    },
  },
});
