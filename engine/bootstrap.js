import { loadBitmaps } from "./bitmaps.js";
import { compileRoomScripts as loadRoomScripts, loadProject } from "./project.js";
import { Runtime, debugUrl } from "./runtime.js";

export { loadProject, overlayIni, siblingPath } from "./project.js";
export { Runtime, debugUrl } from "./runtime.js";
export const debugModeFromSearch = (search) => new URLSearchParams(search).has("debug");
export const fetchText = async (path, fetcher = fetch) => { const response = await fetcher(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };
export const fetchOptionalText = async (path, fetcher = fetch) => { const response = await fetcher(path); if (response.status === 404) return null; if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };
export const compileRoomScripts = (scriptPath, roomIniPath, context, debugMode, fetcher = fetch, compiler) =>
  loadRoomScripts(scriptPath, roomIniPath, context, debugMode, (path, options = {}) => options.optional ? fetchOptionalText(path, fetcher) : fetchText(path, fetcher), compiler);

export async function bootBrowser({ document: page = document, fetcher = fetch } = {}) {
  const host = page.querySelector("#engine-host"), entry = page.querySelector('meta[name="game-entry"]')?.content;
  if (!host || !entry) return null;
  const debugMode = debugModeFromSearch(page.defaultView.location.search);
  const loadText = (path, options = {}) => options.optional ? fetchOptionalText(path, fetcher) : fetchText(path, fetcher);
  const project = await loadProject(entry, { loadText, loadAssets: (graphics, base) => loadBitmaps(graphics, base, fetcher), debug: debugMode });
  const runtime = new Runtime(project, { host, storage: page.defaultView.localStorage, debugMode });
  runtime.start(); return runtime;
}

const host = typeof document === "undefined" ? null : document.querySelector("#engine-host");
if (host) bootBrowser().catch((error) => { host.textContent = `Cannot start game: ${error.message}`; host.ariaBusy = "false"; console.error(error); });
