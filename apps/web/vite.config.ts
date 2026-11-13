import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const rootDir = fileURLToPath(new URL(".", import.meta.url));
  // 开发期把 REST 与 Socket.IO 都代理到后端；默认 8080，验收时可用 VITE_API_TARGET 指到本地实例
  const apiTarget = loadEnv(mode, rootDir, "VITE_").VITE_API_TARGET || "http://127.0.0.1:8080";

  return {
    plugins: [react()],
    define: {
      "process.env.IS_PREACT": JSON.stringify("false"),
    },
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        // workspace 包直接指向 TS 源码，避免依赖 npm 生成的 junction 是否可解析
        "@whiteboard/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        // 不能 changeOrigin：服务端 sameOriginOnly 比较 Origin 与 Host，
        // 改写 Host 会把所有 POST（注册/登录等）判成跨站并返回 403。
        "/api": { target: apiTarget, changeOrigin: false },
        // Socket.IO 走同源，开发期由 Vite 代理 websocket
        "/socket.io": { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
  };
});
