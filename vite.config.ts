import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "react-native": "react-native-web",
    },
  },
  // react-native-web's Animated module (vendor/react-native/Animated/animations/*)
  // calls the bare Node/RN global `global.cancelAnimationFrame` -- browsers only
  // have `window`. Webpack-based RN-web setups get this for free from a default
  // polyfill; Vite doesn't define it, so anything using Animated throws
  // "global is not defined" until something supplies it.
  define: {
    global: "window",
  },
  // Tauri expects a fixed port and will fail if it's already in use.
  server: {
    port: 1420,
    strictPort: true,
  },
});
