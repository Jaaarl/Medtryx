import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: env.VITE_BASE_PATH ?? "/",
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": `http://127.0.0.1:${process.env.MEDTRYX_API_PORT ?? "3001"}`,
      },
    },
  };
});
