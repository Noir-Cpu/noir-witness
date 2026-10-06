import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { witnessSite } from "./site.ts";

export default defineConfig(({ mode }) => ({
  plugins: [react(), witnessSite(loadEnv(mode, process.cwd(), "VITE_"))],
  server: { proxy: { "/api": "http://localhost:8787" } },
}));
