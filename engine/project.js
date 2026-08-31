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
  const handlers = compiler(await loadText(scriptPath), compiler === compile ? { ...context, path: scriptPath } : context);
  if (debugMode) {
    const debugPath = siblingPath(roomIniPath, "debug.ana");
    const source = await loadText(debugPath, { optional: true });
    if (source === null || source === undefined) diagnostics.push({ severity: "info", code: "optional-file-missing", path: debugPath, message: "Optional room debug script not found" });
    else handlers.push(...compiler(source, compiler === compile ? { ...context, path: debugPath } : context));
  }
  return handlers;
}

/** Load and validate a package without assuming a browser, DOM, or transport. */
export async function loadProject(entryPath, { loadText, loadAssets = async () => Object.create(null), debug = false, parser = parseIni, compiler = compile, onConfiguration } = {}) {
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
  onConfiguration?.(configuration);
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
  const entryScriptPath = resolvePackagePath(base, configuration.package.entry_script);
  const handlers = compiler(await loadText(entryScriptPath), { path: entryScriptPath });
  const rooms = Object.create(null);
  for (const id of list(roomCatalogue.catalogue.rooms)) {
    const spec = roomCatalogue[`room.${id}`];
    if (!spec) { diagnostics.push(projectDiagnostic(entryPath, "catalogue-missing-entry", `Room catalogue references missing section room.${id}`)); continue; }
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
      if (!definition) { diagnostics.push(projectDiagnostic(path, "catalogue-missing-entry", `Item catalogue references missing section inventory.${id}`)); continue; }
      items[id] = definition;
      if (definition.script) {
        const scriptPath = resolvePackagePath(itemBase, definition.script);
        handlers.push(...compiler(await loadText(scriptPath), { itemId: id, path: scriptPath }));
      }
    }
  }
  validateReferences({ entryPath, roomCatalogue, rooms, items, graphics, handlers, diagnostics });
  return { configuration, ui, input, roomCatalogue, rooms, itemCatalogue, items, resourceCatalogue, graphics, animations, bitmaps, handlers, diagnostics };
}

const projectDiagnostic = (path, code, message, severity = "error") => ({
  path, filePath: path, line: 1, column: 1, range: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } }, severity, code, message
});

function validateReferences({ entryPath, rooms, items, graphics, handlers, diagnostics }) {
  const graphicIds = new Set(Object.keys(graphics).filter((id) => id.startsWith("graphic.")).map((id) => id.slice(8)));
  for (const [roomId, room] of Object.entries(rooms)) {
    const roomPath = room.$syntax?.path || entryPath;
    const spawns = new Set(Object.keys(room).filter((id) => id.startsWith("spawn.")).map((id) => id.slice(6)));
    for (const [section, value] of Object.entries(room)) {
      if (section.startsWith("entity.") && value.graphic && !graphicIds.has(value.graphic)) diagnostics.push(projectDiagnostic(roomPath, "graphic-not-found", `${section} references nonexistent graphic ${value.graphic}`));
      if (section.startsWith("trigger.")) {
        const destination = section.slice(8);
        if (!Object.hasOwn(rooms, destination)) diagnostics.push(projectDiagnostic(roomPath, "room-not-found", `${section} references nonexistent room ${destination}`));
        else if (!Object.hasOwn(rooms[destination], `spawn.${roomId}`)) diagnostics.push(projectDiagnostic(roomPath, "spawn-not-found", `Room ${destination} has no spawn named ${roomId}`));
      }
    }
    // A room should always have at least one usable entry point.
    if (!spawns.size) diagnostics.push(projectDiagnostic(roomPath, "spawn-missing", `Room ${roomId} declares no spawns`, "warning"));
  }
  const walk = (body, handler) => {
    for (const command of body || []) {
      if (command.op === "enter") {
        if (!Object.hasOwn(rooms, command.room)) diagnostics.push(projectDiagnostic(entryPath, "room-not-found", `Script references nonexistent room ${command.room}`));
        else if (!Object.hasOwn(rooms[command.room], `spawn.${command.spawn}`)) diagnostics.push(projectDiagnostic(entryPath, "spawn-not-found", `Room ${command.room} has no spawn named ${command.spawn}`));
      }
      if (handler.roomId && ["show", "hide", "enable", "disable"].includes(command.op) && !Object.hasOwn(rooms[handler.roomId], `entity.${command.target}`) && !Object.hasOwn(items, command.target))
        diagnostics.push(projectDiagnostic(entryPath, "entity-unavailable", `${command.target} is unavailable in room ${handler.roomId}`));
      walk(command.body, handler); walk(command.yes, handler); walk(command.no, handler);
    }
  };
  for (const handler of handlers) walk(handler.body, handler);
}

/** Editor-facing validation uses exactly the production loader and parsers. */
export async function validateProject(entryPath, loaders) {
  try { return await loadProject(entryPath, loaders); }
  catch (error) {
    const diagnostic = error.diagnostic || projectDiagnostic(error.path || entryPath, "project-invalid", error.message);
    return { project: null, diagnostics: [{ ...diagnostic, message: error.message, error }] };
  }
}
