import { parseIni, list } from "./ini.js";
import { compile } from "./script.js";
import { resolvePackagePath } from "./path.js";
import { parseActionBindings } from "./input.js";

export const siblingPath = (path, name) => `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;

export function overlayIni(base, override) {
  const merged = Object.create(null);
  Object.defineProperty(merged, "$variables", { value: { ...base.$variables, ...override.$variables }, enumerable: false });
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const normal = base[key], replacement = override[key];
    merged[key] = normal && replacement && typeof normal === "object" && typeof replacement === "object"
      ? { ...normal, ...replacement } : (replacement ?? normal);
  }
  return merged;
}

export async function compileRoomScripts(scriptPath, roomIniPath, context, debugMode, loadText, compiler = compile, diagnostics = []) {
  const handlers = compiler(await loadText(scriptPath), context);
  if (debugMode) {
    const debugPath = siblingPath(roomIniPath, "debug.ana");
    const source = await loadText(debugPath, { optional: true });
    if (source === null || source === undefined) diagnostics.push({ severity: "info", code: "optional-file-missing", path: debugPath, message: "Optional room debug script not found" });
    else handlers.push(...compiler(source, context));
  }
  return handlers;
}

/** Load and validate a package without assuming a browser, DOM, or transport. */
export async function loadProject(entryPath, { loadText, loadAssets = async () => Object.create(null), debug = false, parser = parseIni, compiler = compile } = {}) {
  if (typeof loadText !== "function") throw new TypeError("loadProject requires a loadText(path, options) function");
  const diagnostics = [];
  const readIni = async (path) => parser(await loadText(path), path);
  const base = siblingPath(entryPath, "");
  let configuration = await readIni(entryPath);
  if (debug) {
    const debugPath = siblingPath(entryPath, "debug.ini"), source = await loadText(debugPath, { optional: true });
    if (source == null) diagnostics.push({ severity: "info", code: "optional-file-missing", path: debugPath, message: "Optional package debug configuration not found" });
    else configuration = overlayIni(configuration, parser(source, debugPath));
  }
  const resourceCataloguePath = resolvePackagePath(base, configuration.package.resource_catalogue);
  const resourceBase = siblingPath(resourceCataloguePath, "");
  const resourceCatalogue = await readIni(resourceCataloguePath);
  const ui = await readIni(resolvePackagePath(base, configuration.package.interface));
  const input = parseActionBindings(await readIni(resolvePackagePath(base, configuration.input.bindings)));
  const roomCatalogue = await readIni(resolvePackagePath(base, configuration.package.room_catalogue));
  const graphicsPath = resourceCatalogue.catalogue.graphics || configuration.package.graphics;
  const graphics = await readIni(resolvePackagePath(resourceBase, graphicsPath));
  const animations = await readIni(resolvePackagePath(resourceBase, resourceCatalogue.catalogue.player_animations));
  const bitmaps = await loadAssets(graphics, resourceBase);
  const handlers = compiler(await loadText(resolvePackagePath(base, configuration.package.entry_script)));
  const rooms = Object.create(null);
  for (const id of list(roomCatalogue.catalogue.rooms)) {
    const spec = roomCatalogue[`room.${id}`];
    if (!spec) throw new Error(`room catalogue references missing section room.${id}`);
    const iniPath = resolvePackagePath(base, spec.path);
    rooms[id] = await readIni(iniPath);
    const entities = Object.keys(rooms[id]).filter((section) => section.startsWith("entity.")).map((section) => section.slice(7));
    handlers.push(...await compileRoomScripts(resolvePackagePath(base, spec.script), iniPath, { roomId: id, entities }, debug, loadText, compiler, diagnostics));
  }
  const items = Object.create(null);
  let itemCatalogue = null;
  if (configuration.package.item_catalogue) {
    const path = resolvePackagePath(base, configuration.package.item_catalogue);
    itemCatalogue = await readIni(path);
    const itemBase = siblingPath(path, "");
    for (const id of list(itemCatalogue.catalogue.items)) {
      const definition = itemCatalogue[`inventory.${id}`];
      if (!definition) throw new Error(`item catalogue references missing section inventory.${id}`);
      items[id] = definition;
      if (definition.script) handlers.push(...compiler(await loadText(resolvePackagePath(itemBase, definition.script)), { itemId: id }));
    }
  }
  return { configuration, ui, input, roomCatalogue, rooms, itemCatalogue, items, resourceCatalogue, graphics, animations, bitmaps, handlers, diagnostics };
}

/** Editor-facing validation uses exactly the production loader and parsers. */
export async function validateProject(entryPath, loaders) {
  try { return await loadProject(entryPath, loaders); }
  catch (error) { return { project: null, diagnostics: [{ severity: "error", code: "project-invalid", message: error.message, error }] }; }
}
