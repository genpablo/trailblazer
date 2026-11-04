import { defineConfig } from "vite";

/**
 * The chat page. The API serves dist/index.html at /c/<public-key> (with a per-bot
 * frame-ancestors policy) and the assets under /chat-assets/.
 */
export default defineConfig({
  base: "/chat-assets/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    assetsDir: "assets",
  },
});
