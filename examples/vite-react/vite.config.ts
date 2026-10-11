import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rewindryPreviewPlugin } from '../../src/vite-plugin.ts';

export default defineConfig({
  plugins: [react(), rewindryPreviewPlugin('vite-react-fixture')],
});
