import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';

export default defineConfig(({ command }) => {
  // If we are running 'vite build', include the devvit plugin.
  // If we are running 'npx vite' (command === 'serve'), exclude it.
  if (command === 'serve') {
    return {
      plugins: [],
      server: {
        host: true,
      },
    };
  }

  // Default production/build configuration
  return {
    plugins: [
      devvit({
        client: {
          build: {
            chunkSizeWarningLimit: 2000,
          },
        },
      }),
    ],
  };
});