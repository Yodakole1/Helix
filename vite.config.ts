import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "react-native": "react-native-web",
    },
  },
  // Tauri expects a fixed port and will fail if it's already in use.
  server: {
    port: 1420,
    strictPort: true,
  },
});
