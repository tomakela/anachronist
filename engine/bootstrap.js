import { loadBitmaps } from "./bitmaps.js";
import { compileRoomScripts as loadRoomScripts, loadProject } from "./project.js";
import { Runtime, debugUrl } from "./runtime.js";
import { integer, tuple } from "./ini.js";

export { loadProject, overlayIni, siblingPath } from "./project.js";
export { Runtime, debugUrl } from "./runtime.js";
export const debugModeFromSearch = (search) => new URLSearchParams(search).has("debug");
export const fetchText = async (path, fetcher = fetch) => { const response = await fetcher(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };
export const fetchOptionalText = async (path, fetcher = fetch) => { const response = await fetcher(path); if (response.status === 404) return null; if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };
export const compileRoomScripts = (scriptPath, roomIniPath, context, debugMode, fetcher = fetch, compiler) =>
  loadRoomScripts(scriptPath, roomIniPath, context, debugMode, (path, options = {}) => options.optional ? fetchOptionalText(path, fetcher) : fetchText(path, fetcher), compiler);

/** Draw the startup indicator on the same integer pixel grid as the game. */
export function createLoadingBar(page, host, configuration) {
  const display = configuration.display, spec = configuration.loading || {};
  const width = integer(display.logical_width, "logical_width"), height = integer(display.logical_height, "logical_height");
  const [barWidth, barHeight] = tuple(spec.size || "160,12", 2, "loading bar size").map((value) => integer(String(value), "loading bar size"));
  const wall = integer(spec.wall_thickness || "2", "loading bar wall thickness");
  if (barWidth <= wall * 2 || barHeight <= wall * 2) throw new Error("loading bar size must be larger than twice its wall thickness");
  const canvas = page.createElement("canvas"); canvas.width = width; canvas.height = height; canvas.className = "loading-screen";
  const aspect = width / height;
  canvas.style.aspectRatio = `${width} / ${height}`; canvas.style.setProperty("--game-width", `min(calc(100dvw - env(safe-area-inset-left) - env(safe-area-inset-right)), calc((100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)) * ${aspect}))`); canvas.style.setProperty("--game-height", `min(calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)), calc((100dvw - env(safe-area-inset-left) - env(safe-area-inset-right)) / ${aspect}))`);
  canvas.setAttribute("role", "progressbar"); canvas.setAttribute("aria-label", spec.accessible_label || "Loading game"); canvas.setAttribute("aria-valuemin", "0"); canvas.setAttribute("aria-valuemax", "100");
  const context = canvas.getContext("2d"), x = Math.floor((width - barWidth) / 2), y = Math.floor((height - barHeight) / 2), innerWidth = barWidth - wall * 2;
  const draw = (progress) => {
    const value = Math.max(0, Math.min(1, progress));
    context.clearRect(0, 0, width, height); context.fillStyle = spec.rectangle_color || "#d3a94f"; context.fillRect(x, y, barWidth, barHeight);
    context.clearRect(x + wall, y + wall, innerWidth, barHeight - wall * 2); context.fillStyle = spec.bar_color || "#f4d58a"; context.fillRect(x + wall, y + wall, Math.floor(innerWidth * value), barHeight - wall * 2);
    canvas.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  };
  draw(0); host.replaceChildren(canvas); return { canvas, update: draw };
}

export async function bootBrowser({ document: page = document, fetcher = fetch } = {}) {
  const host = page.querySelector("#engine-host"), entry = page.querySelector('meta[name="game-entry"]')?.content;
  if (!host || !entry) return null;
  const debugMode = debugModeFromSearch(page.defaultView.location.search);
  let loading, completed = 0;
  const advance = () => loading?.update(Math.min(0.9, 0.12 + ++completed * 0.035));
  const loadText = async (path, options = {}) => { const text = await (options.optional ? fetchOptionalText(path, fetcher) : fetchText(path, fetcher)); advance(); return text; };
  const project = await loadProject(entry, {
    loadText,
    loadAssets: (graphics, base) => loadBitmaps(graphics, base, fetcher, createImageBitmap, undefined, advance),
    debug: debugMode,
    onConfiguration: (configuration) => { loading = createLoadingBar(page, host, configuration); loading.update(0.1); }
  });
  loading?.update(1);
  const runtime = new Runtime(project, { host, storage: page.defaultView.localStorage, debugMode });
  runtime.start(); return runtime;
}

const host = typeof document === "undefined" ? null : document.querySelector("#engine-host");
if (host) bootBrowser().catch((error) => { host.textContent = `Cannot start game: ${error.message}`; host.ariaBusy = "false"; console.error(error); });
