import { defineConfig } from 'vite';

// `base: './'` makes the built bundle path-relative, so the same build works on
// GitHub Pages (https://org.github.io/repo/), S3/CloudFront, Azure Static Web
// Apps or any sub-folder of an existing web server.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
    // The Genesys Platform SDK alone is ~1.5 MB unminified; this is expected.
    chunkSizeWarningLimit: 2000
  },
  server: {
    port: 5173
  }
});
