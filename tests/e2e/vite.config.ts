import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: [
      // Specific stubs first so they win over the `@` catch-all below.
      {
        find: "@assistant-ui/react-langgraph",
        replacement: path.resolve(__dirname, "./stubs/langgraph.ts"),
      },
      { find: "wagmi", replacement: path.resolve(__dirname, "./stubs/wagmi.ts") },
      {
        find: "@rainbow-me/rainbowkit",
        replacement: path.resolve(__dirname, "./stubs/rainbowkit.ts"),
      },
      {
        find: "@/lib/alchemy/portfolio",
        replacement: path.resolve(__dirname, "./portfolio-stub.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "../..") },
    ],
  },
  server: {
    port: 3100,
    strictPort: true,
    host: "127.0.0.1",
  },
});
