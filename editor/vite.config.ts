import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const gameDirectory = fileURLToPath(new URL("../game", import.meta.url));

async function gameEntries(directory = gameDirectory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? gameEntries(path) : [relative(gameDirectory, path).split(sep).join("/")];
  }))).flat();
}

const developmentGame = {
  name: "anachronist-development-game",
  configureServer(server: Parameters<NonNullable<ReturnType<typeof defineConfig>["plugins"]>[number]["configureServer"]>[0]) {
    server.middlewares.use("/__anachronist-game", async (request, response) => {
      const url = new URL(request.url || "", "http://localhost");
      try {
        if (url.pathname === "/entries") {
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(await gameEntries())); return;
        }
        if (url.pathname === "/file") {
          const path = url.searchParams.get("path") || "";
          const file = resolve(gameDirectory, path);
          if (!path || !file.startsWith(`${gameDirectory}${sep}`)) { response.statusCode = 400; response.end("Invalid game path"); return; }
          response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.end(await readFile(file)); return;
        }
        response.statusCode = 404; response.end();
      } catch { response.statusCode = 404; response.end(); }
    });
  }
};

export default defineConfig({
  plugins: [react(), developmentGame],
  server: { fs: { allow: [".."] } },
  build: { outDir: "dist", emptyOutDir: true }
});
