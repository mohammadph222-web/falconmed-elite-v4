import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Production builds carry a Content Security Policy: scripts only from this
 * site, network calls only to this site and the API. The API origin comes from
 * VITE_API_URL at build time, so the policy always matches the deployment.
 */
function contentSecurityPolicy(apiUrl) {
  const api = new URL(apiUrl).origin;
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src 'self' ${api}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), contentSecurityPolicy(env.VITE_API_URL || 'http://localhost:5000')],
    server: { port: 5173 },
    build: {
      rollupOptions: {
        output: {
          // Keep the charting library out of the first-load bundle.
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
          },
        },
      },
    },
  };
});
