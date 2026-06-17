import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:3000",
      "/portal": "http://127.0.0.1:3000"
    }
  }
});
