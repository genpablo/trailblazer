import { defineConfig } from "vite";

/** The floating-widget loader: a tiny classic script customers add to their site (dist/widget.js). */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2017",
    lib: {
      entry: "src/widget.ts",
      name: "TraiblazerWidget",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
  },
});
