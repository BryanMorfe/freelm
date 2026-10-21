import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the gallery's iframe/server separate from the app's HTML, CSP and dev port.
// Components still import the very same source modules and styles as the app.
export default defineConfig({
	plugins: [react()],
	resolve: { dedupe: ['react', 'react-dom'] },
	server: { host: '127.0.0.1', fs: { strict: true } },
});
