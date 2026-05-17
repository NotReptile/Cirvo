import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiTarget = env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8080";
  const wsTarget = env.VITE_REALTIME_PROXY_TARGET ?? "ws://127.0.0.1:8090";

  return {
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true
        },
        "/ws": {
          target: wsTarget,
          ws: true,
          changeOrigin: true
        }
      }
    },
    envPrefix: ["VITE_", "TAURI_"]
  };
});
