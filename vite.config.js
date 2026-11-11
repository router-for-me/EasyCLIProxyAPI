import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/');
          // Keep pure translation data out of the application chunk. These
          // modules have no runtime dependency on React or application services.
          if (/\/src\/i18n\/(?:locales\/[^/]+|resources|ja|ru|traditional|easyMode|home|authFileList|themeDiy|acp)\.ts$/.test(normalizedId)) {
            return 'translations';
          }
          if (!normalizedId.includes('/node_modules/')) return undefined;
          if (normalizedId.includes('/node_modules/@tauri-apps/')) return 'tauri-vendor';
          if (normalizedId.includes('/node_modules/@dnd-kit/')) return 'dnd-vendor';
          if (normalizedId.includes('/node_modules/lucide-react/')) return 'icons-vendor';
          if (
            normalizedId.includes('/node_modules/react/')
            || normalizedId.includes('/node_modules/react-dom/')
            || normalizedId.includes('/node_modules/scheduler/')
          ) return 'react-vendor';
          return 'vendor';
        },
      },
    },
  },
});
