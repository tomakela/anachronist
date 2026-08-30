import { parseIni, integer, tuple, list } from "./ini.js";
import { BackgroundTasks, compile, instantiate, textDuration } from "./script.js";
import { resolvePackagePath } from "./path.js";
import { bitmapPixels, loadBitmaps, nearestNeighbor } from "./bitmaps.js";
import { parseActionBindings } from "./input.js";
import { SaveStorage, snapshotRuntime, validateSnapshot } from "./save.js";
import { DeterministicVM } from "./vm.js";
import { accelerateCommandQueue, advanceWalk, bitmapWalkRegion, dragCursor, enteredTriggers, entityHotspot, entityRenderOrder, entityTargetAt, interfacePoint, interpolatedScale, inventoryLastRow, inventoryPage, objectSuggestedVerb, parseScalingStops, pointInHotspot, retainedRoomEntities, roomEntryItems, shakeOffset, spriteAlphaHit, touchMoved, verbSentence } from "./interaction.js";

const root = typeof document === "undefined" ? null : document.querySelector("#engine-host");
const entry = typeof document === "undefined" ? null : document.querySelector('meta[name="game-entry"]')?.content;
export const debugModeFromSearch = (search) => new URLSearchParams(search).has("debug");

export function overlayIni(base, override) {
  const merged = Object.create(null);
  Object.defineProperty(merged, "$variables", { value: { ...base.$variables, ...override.$variables }, enumerable: false });
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const normal = base[key], debug = override[key];
    merged[key] = normal && debug && typeof normal === "object" && typeof debug === "object"
      ? { ...normal, ...debug }
      : (debug ?? normal);
  }
  return merged;
}

export const siblingPath = (path, name) => `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
export const debugUrl = (url, enabled) => {
  const result = new URL(url);
  if (enabled) result.searchParams.set("debug", ""); else result.searchParams.delete("debug");
  return result.href;
};
export const fetchText = async (path, fetcher = fetch) => { const response = await fetcher(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };
export const fetchOptionalText = async (path, fetcher = fetch) => { const response = await fetcher(path); if (response.status === 404) return null; if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };

export async function compileRoomScripts(scriptPath, roomIniPath, context, debugMode, fetcher = fetch, compiler = compile) {
  const handlers = compiler(await fetchText(scriptPath, fetcher), context);
  if (debugMode) {
    const debugPath = siblingPath(roomIniPath, "debug.ana"), source = await fetchOptionalText(debugPath, fetcher);
    if (source !== null) handlers.push(...compiler(source, context));
  }
  return handlers;
}

async function boot() {
  const debugMode = debugModeFromSearch(window.location.search);
  let game = parseIni(await fetchText(entry), entry);
  const base = entry.slice(0, entry.lastIndexOf("/") + 1);
  if (debugMode) {
    const debugPath = siblingPath(entry, "debug.ini"), source = await fetchOptionalText(debugPath);
    if (source !== null) game = overlayIni(game, parseIni(source, debugPath));
  }
  const resourceCataloguePath = resolvePackagePath(base, game.package.resource_catalogue);
  const resourceBase = resourceCataloguePath.slice(0, resourceCataloguePath.lastIndexOf("/") + 1);
  const resources = parseIni(await fetchText(resourceCataloguePath));
  const ui = parseIni(await fetchText(resolvePackagePath(base, game.package.interface)));
  const input = parseActionBindings(parseIni(await fetchText(resolvePackagePath(base, game.input.bindings))));
  const roomsIndex = parseIni(await fetchText(resolvePackagePath(base, game.package.room_catalogue)));
  const graphicsPath = resources.catalogue.graphics || game.package.graphics;
  const graphics = parseIni(await fetchText(resolvePackagePath(resourceBase, graphicsPath)));
  const animations = parseIni(await fetchText(resolvePackagePath(resourceBase, resources.catalogue.player_animations)));
  const bitmaps = await loadBitmaps(graphics, resourceBase);
  const handlers = compile(await fetchText(resolvePackagePath(base, game.package.entry_script)));
  const rooms = Object.create(null);
  for (const id of list(roomsIndex.catalogue.rooms)) {
    const spec = roomsIndex[`room.${id}`];
    const roomIniPath = resolvePackagePath(base, spec.path);
    rooms[id] = parseIni(await fetchText(roomIniPath));
    const entities = Object.keys(rooms[id]).filter((section) => section.startsWith("entity.")).map((section) => section.slice(7));
    handlers.push(...await compileRoomScripts(resolvePackagePath(base, spec.script), roomIniPath, { roomId: id, entities }, debugMode));
  }
  const items = Object.create(null);
  if (game.package.item_catalogue) {
    const itemPath = resolvePackagePath(base, game.package.item_catalogue), itemIndex = parseIni(await fetchText(itemPath));
    const itemBase = itemPath.slice(0, itemPath.lastIndexOf("/") + 1);
    for (const id of list(itemIndex.catalogue.items)) {
      items[id] = itemIndex[`inventory.${id}`];
      const script = items[id].script;
      if (script) handlers.push(...compile(await fetchText(resolvePackagePath(itemBase, script)), { itemId: id }));
    }
  }
  new Runtime(game, ui, rooms, items, graphics, animations, bitmaps, handlers, input, debugMode).start();
}

export class Runtime extends DeterministicVM {
  constructor(game, ui, rooms, items, graphics, animations, bitmaps, handlers, input, debugMode = false) {
    super();
    Object.assign(this, { game, ui, rooms, items, graphics, animations, bitmaps, handlers, input, debugMode });
    this.saveIdentity = { packageId: game.package.id, formatVersion: game.save?.format_version };
    if (!this.saveIdentity.packageId || !this.saveIdentity.formatVersion) throw new Error("package.id and save.format_version are required");
    this.storage = new SaveStorage(window.localStorage, this.saveIdentity.packageId);
    this.entities = Object.create(null); this.roomEntities = Object.create(null); this.inventory = []; this.inventoryEntities = Object.create(null); this.globals = { ...game.$variables };
    this.roomState = Object.fromEntries(Object.entries(rooms).map(([id, room]) => [id, { ...room.$variables }]));
    this.activeVerb = null; this.firstObject = null; this.hoverTarget = null; this.queue = []; this.backgroundTasks = new BackgroundTasks((command) => this.performBackground(command)); this.message = ""; this.messageKind = ""; this.messageTicks = 0; this.actionSentence = ""; this.tick = 0; this.shakeTicks = 0; this.inventoryRow = 0;
    this.width = integer(game.display.logical_width, "logical_width"); this.height = integer(game.display.logical_height, "logical_height");
    this.canvas = document.createElement("canvas"); this.canvas.width = this.width; this.canvas.height = this.height;
    const aspect = this.width / this.height;
    const safeWidth = "(100dvw - env(safe-area-inset-left) - env(safe-area-inset-right))", safeHeight = "(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))";
    this.canvas.style.aspectRatio = `${this.width} / ${this.height}`; this.canvas.style.setProperty("--game-width", `min(calc${safeWidth}, calc(${safeHeight} * ${aspect}))`); this.canvas.style.setProperty("--game-height", `min(calc${safeHeight}, calc(${safeWidth} / ${aspect}))`);
    this.canvas.setAttribute("aria-label", ui.interface.accessible_label); this.canvas.setAttribute("role", "application"); this.canvas.tabIndex = 0; this.ctx = nearestNeighbor(this.canvas.getContext("2d"));
    this.coarsePointer = matchMedia("(pointer: coarse)").matches;
    this.cursorMode = localStorage.getItem("anachronist.cursor-mode") || "drag";
    this.draggingSensitivity = Number(game.input.dragging_sensitivity);
    if (!Number.isFinite(this.draggingSensitivity) || this.draggingSensitivity <= 0) throw new Error("dragging_sensitivity must be a positive number");
    this.longTouchMilliseconds = integer(game.input.long_touch_milliseconds, "long touch milliseconds");
    this.longTouchMoveTolerance = Number(game.input.long_touch_move_tolerance ?? 8);
    if (!Number.isFinite(this.longTouchMoveTolerance) || this.longTouchMoveTolerance < 0) throw new Error("long_touch_move_tolerance must be a non-negative number");
    this.walkSpeed = Number(game.runtime.walk_speed); this.fastWalkMultiplier = Number(game.runtime.fast_walk_multiplier);
    if (!Number.isFinite(this.walkSpeed) || this.walkSpeed <= 0) throw new Error("walk_speed must be a positive number");
    if (!Number.isFinite(this.fastWalkMultiplier) || this.fastWalkMultiplier < 1) throw new Error("fast_walk_multiplier must be at least 1");
    this.doubleTouchMilliseconds = integer(game.input.double_touch_milliseconds, "double touch milliseconds");
    this.doubleTouchMoveTolerance = Number(game.input.double_touch_move_tolerance);
    if (!Number.isFinite(this.doubleTouchMoveTolerance) || this.doubleTouchMoveTolerance < 0) throw new Error("double_touch_move_tolerance must be a non-negative number");
    this.touchCursor = [this.width / 2, this.height / 2]; this.touch = null; this.lastTap = null;
    root.replaceChildren(this.canvas, this.settings()); root.ariaBusy = "false";
  }
  start() {
    this.dispatch("game.start", []);
    root.addEventListener("pointerdown", (event) => this.pointerDown(event));
    root.addEventListener("pointermove", (event) => this.pointerMove(event));
    root.addEventListener("pointerup", (event) => this.pointerUp(event));
    root.addEventListener("pointercancel", (event) => this.cancelTouch(event));
    root.addEventListener("lostpointercapture", (event) => this.cancelTouch(event));
    this.canvas.addEventListener("pointerleave", () => { this.hoverTarget = null; });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("keydown", (event) => this.keyboard(event));
    this.canvas.focus(); this.last = performance.now(); requestAnimationFrame((now) => this.frame(now));
  }
  keyboard(event) {
    const action = this.input.keyboard.get(event.code) || this.input.keyboard.get(event.key);
    if (!action) return;
    event.preventDefault(); this.inputAction(action, { event });
  }
  inputAction(action, detail = {}) {
    if (!this.interactive && action !== "cancel" && action !== "dialogue_advance" && action !== "pointer_primary") return;
    if (action === "pointer_primary") return this.action({ type: "pointer", button: 0, point: detail.point, fast: detail.fast });
    if (action === "pointer_secondary") return this.action({ type: "pointer", button: 2, point: detail.point, fast: detail.fast });
    if (action === "verb_look") return this.selectVerb("look");
    if (action.startsWith("verb_")) return this.selectVerb(action.slice(5));
    if (action === "dialogue_advance") { if (this.message) this.dismissMessage(); return; }
    if (action === "cancel") return this.cancelInteraction();
  }
  selectVerb(verb) { if (this.message) this.dismissMessage(); this.stopWalking(); this.activeVerb = verb; this.firstObject = null; }
  cancelInteraction() { this.clearSelection(); this.interruptCommands(); if (this.message) this.dismissMessage(); this.actionSentence = ""; }
  settings() {
    const wrapper = document.createElement("div"); wrapper.className = "mobile-settings";
    const button = document.createElement("button"); button.type = "button"; button.textContent = "⚙"; button.ariaLabel = "Game settings"; button.ariaExpanded = "false";
    const choices = document.createElement("fieldset"); choices.hidden = true;
    const legend = document.createElement("legend"); legend.textContent = "Game settings"; choices.append(legend);
    const debugRow = document.createElement("label"), debug = document.createElement("input"); debug.type = "checkbox"; debug.checked = this.debugMode;
    debug.addEventListener("change", () => { window.location.href = debugUrl(window.location.href, debug.checked); });
    debugRow.append(debug, " Debug mode"); choices.append(debugRow);
    for (const [value, label] of [["direct", "Point where I touch"], ["drag", "Drag cursor"]]) {
      const row = document.createElement("label"), radio = document.createElement("input"); radio.type = "radio"; radio.name = "cursor-mode"; radio.value = value; radio.checked = this.cursorMode === value;
      radio.addEventListener("change", () => { this.cursorMode = value; localStorage.setItem("anachronist.cursor-mode", value); });
      row.append(radio, ` ${label}`); choices.append(row);
    }
    const fullscreen = document.createElement("button"); fullscreen.type = "button"; fullscreen.className = "fullscreen-toggle"; fullscreen.textContent = "Enter full screen";
    fullscreen.hidden = !document.fullscreenEnabled; fullscreen.addEventListener("click", () => this.toggleFullscreen());
    document.addEventListener("fullscreenchange", () => { fullscreen.textContent = document.fullscreenElement ? "Exit full screen" : "Enter full screen"; });
    choices.append(fullscreen);
    for (const [label, action] of [["Save", () => this.saveGame()], ["Load", () => this.loadGame()], ["Restart", () => this.restartGame()]]) {
      const control = document.createElement("button"); control.type = "button"; control.className = "menu-action"; control.textContent = label; control.addEventListener("click", action); choices.append(control);
    }
    button.addEventListener("click", () => { choices.hidden = !choices.hidden; button.ariaExpanded = String(!choices.hidden); });
    wrapper.append(button, choices); return wrapper;
  }
  reportSaveError(action, error) { window.alert(`${action} failed: ${error.message}`); console.error(error); }
  saveGame() {
    try {
      if (this.storage.exists() && !window.confirm("Overwrite your existing saved progress?")) return;
      this.storage.write(snapshotRuntime(this, this.saveIdentity));
      window.alert("Game saved.");
    } catch (error) { this.reportSaveError("Save", error); }
  }
  loadGame() {
    try {
      const state = validateSnapshot(this.storage.read(), this.saveIdentity, this.rooms, this.items);
      this.applySave(state);
      window.alert("Game loaded.");
    } catch (error) { this.reportSaveError("Load", error); }
  }
  applySave(state) {
    // Derive everything which can throw before assigning a single live field.
    const room = this.rooms[state.room], interactive = room.room.interactive !== "false", interfaceVisible = room.room.interface_visible !== "false" && room.room.fullscreen !== "true";
    const playerScaling = parseScalingStops(room.room.player_scaling || "0,1; 1,1", `${state.room}.room.player_scaling`);
    const playerWalkSpeedScaling = parseScalingStops(room.room.player_walk_speed_scaling || "0,1; 1,1", `${state.room}.room.player_walk_speed_scaling`);
    const mask = room.room.walk_mask;
    const walkable = mask ? bitmapWalkRegion(this.bitmaps[mask], this.width, this.height) : () => true;
    const triggers = Object.fromEntries(Object.entries(room).filter(([section]) => section.startsWith("trigger.")).map(([section, values]) => [section.slice(8), tuple(values.rect, 4, `${section}.rect`)]));
    const occupiedTriggers = enteredTriggers(state.entities[state.room].player.position, triggers).occupied;
    Object.assign(this, { room: state.room, roomEntities: state.entities, entities: state.entities[state.room], globals: state.globals, roomState: state.roomState, inventory: state.inventory, inventoryEntities: state.inventoryEntities, inventoryRow: state.inventoryRow, interactive, interfaceVisible, playerScaling, playerWalkSpeedScaling, walkable, triggers, occupiedTriggers });
    this.queue = []; this.message = ""; this.messageKind = ""; this.messageTicks = 0; this.actionSentence = ""; this.clearSelection(); this.hoverTarget = null;
  }
  restartGame() { if (window.confirm("Restart and discard all current progress?")) window.location.reload(); }
  async toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen(); screen.orientation?.unlock?.(); return;
    }
    await root.requestFullscreen({ navigationUI: "hide" });
    await screen.orientation?.lock?.("landscape").catch(() => {});
  }
  scriptState() { return { game: this.globals, ...this.roomState }; }
  matchingHandler(event, args) {
    const inventoryTarget = this.inventory.includes(args.at(-1));
    return this.handlers.find((candidate) => candidate.event === event && candidate.args.length === args.length
      && (!candidate.roomId || candidate.roomId === this.room) && (!candidate.localTarget || candidate.localTarget === args.at(-1))
      && (inventoryTarget ? (!candidate.roomId && candidate.inventoryOnly) : !candidate.inventoryOnly));
  }
  dispatch(event, args) { const handler = this.matchingHandler(event, args); if (!handler) return 0; const commands = instantiate(handler, args, this.scriptState()); this.queue.push(...commands); return commands.length; }
  commands(event, args) { const handler = this.matchingHandler(event, args); return handler ? instantiate(handler, args, this.scriptState()) : null; }
  eventPoint(event) { const rect = this.canvas.getBoundingClientRect(); return [(event.clientX - rect.left) * this.width / rect.width, (event.clientY - rect.top) * this.height / rect.height]; }
  hover(event) { const [x, y] = this.eventPoint(event); this.updateHover(x, y); }
  updateHover(x, y) {
    const target = this.targetAt(x, y);
    this.hoverTarget = interfacePoint(x, y, this.ui, this.width, this.height) && !this.activeVerb && !this.inventory.includes(target) ? null : target;
  }
  pointerDown(event) {
    if (event.target.closest?.(".mobile-settings")) return;
    if (event.pointerType !== "touch") { if (event.target === this.canvas) this.action({ type: "pointer", button: event.button, point: this.eventPoint(event), fast: event.button === 0 && event.detail >= 2 }); return; }
    if (this.cursorMode !== "drag" && event.target !== this.canvas) return;
    if (this.touch) return;
    event.preventDefault(); root.setPointerCapture(event.pointerId);
    const point = this.eventPoint(event); if (this.cursorMode === "direct") this.touchCursor = point;
    this.touch = { id: event.pointerId, start: point, last: point, moved: false, long: false, startedAt: performance.now() };
    const pointerId = event.pointerId;
    this.touch.timer = setTimeout(() => { if (this.touch?.id !== pointerId || this.touch.moved) return; this.touch.long = true; this.dispatchPhysicalTouch("long_press", event, this.touchCursor); }, this.longTouchMilliseconds);
  }
  pointerMove(event) {
    if (event.pointerType !== "touch") { if (event.target === this.canvas) this.hover(event); return; }
    if (!this.touch || this.touch.id !== event.pointerId) return;
    const point = this.eventPoint(event), delta = [point[0] - this.touch.last[0], point[1] - this.touch.last[1]];
    if (touchMoved(this.touch.start, point, this.longTouchMoveTolerance)) this.touch.moved = true;
    if (this.cursorMode === "direct") this.touchCursor = point;
    else this.touchCursor = dragCursor(this.touchCursor, delta, this.draggingSensitivity, this.width, this.height);
    this.touch.last = point; this.updateHover(...this.touchCursor);
  }
  pointerUp(event) {
    if (event.pointerType !== "touch" || !this.touch || this.touch.id !== event.pointerId) return;
    clearTimeout(this.touch.timer);
    if (!this.touch.long && !this.touch.moved) {
      const button = performance.now() - this.touch.startedAt >= this.longTouchMilliseconds ? 2 : 0;
      this.touch.long = button === 2;
      const now = performance.now(), fast = button === 0 && this.lastTap && now - this.lastTap.time <= this.doubleTouchMilliseconds && !touchMoved(this.lastTap.point, this.touchCursor, this.doubleTouchMoveTolerance);
      this.dispatchPhysicalTouch(button === 2 ? "long_press" : "tap", event, this.touchCursor, fast);
      if (button === 0) this.lastTap = { time: now, point: [...this.touchCursor] };
    }
    this.touch = null;
  }
  cancelTouch(event) { if (this.touch?.id === event.pointerId) { clearTimeout(this.touch.timer); this.touch = null; } }
  dispatchPhysicalTouch(gesture, event, point, fast = false) { event.preventDefault(); const action = this.input.touch.get(gesture); if (action) this.inputAction(action, { point, event, fast }); }
  accelerateCommands() {
    const skipping = accelerateCommandQueue(this.queue);
    if (skipping) { this.dismissMessage(); const player = this.entities[this.game.protocol.player_actor]; if (player) player.actionTicks = 0; }
  }
  interruptCommands() { this.queue = []; const player = this.entities[this.game.protocol.player_actor]; if (player) { player.moving = false; player.action = null; player.actionTicks = 0; } }
  stopWalking() {
    const command = this.queue[0];
    if (command?.op !== "walk") return;
    this.queue = [];
    const actor = this.entities[command.actor];
    if (actor) actor.moving = false;
    this.actionSentence = "";
  }
  targetAt(x, y, excludeFirst = true) {
    const layout = this.inventoryLayout();
    const inventoryTarget = this.inventory.slice(layout.page.start, layout.page.end).find((id, i) => (!excludeFirst || id !== this.firstObject) && inside(x, y, [layout.origin[0] + i * layout.itemWidth, layout.origin[1], layout.itemWidth, layout.itemHeight]));
    return inventoryTarget || entityTargetAt([x, y], this.entities, (entity, point) => (!excludeFirst || entity.id !== this.firstObject) && this.hitEntity(entity, point));
  }
  hitEntity(entity, point) {
    const hotspot = entityHotspot(entity); if (hotspot) return pointInHotspot(point, hotspot);
    const bounds = this.bounds(entity); if (!inside(...point, bounds)) return false;
    if (entity.alpha_hit_test !== "true") return true;
    const bitmap = this.bitmaps[entity.graphic]; if (!bitmap) return true;
    const source = this.currentFrame(entity) || [0, 0, bitmap.width, bitmap.height];
    return spriteAlphaHit(point, bounds, source, bitmapPixels(bitmap), entity.rotation);
  }
  inventoryLayout() {
    const spec = this.ui.inventory_panel, origin = tuple(spec.origin, 2, "inventory"), itemWidth = integer(spec.item_width, "item width"), itemHeight = integer(spec.item_height, "item height"), arrowWidth = integer(spec.arrow_width || "16", "arrow width");
    const columns = Math.max(1, Math.floor((this.width - origin[0] - arrowWidth) / itemWidth)), page = inventoryPage(this.inventory.length, this.inventoryRow, columns); this.inventoryRow = page.row;
    return { origin, itemWidth, itemHeight, page, upRect: [this.width - arrowWidth, origin[1], arrowWidth, itemHeight / 2], downRect: [this.width - arrowWidth, origin[1] + itemHeight / 2, arrowWidth, itemHeight / 2] };
  }
  suggestedVerb(target) {
    const object = this.inventory.includes(target) ? this.items[target] : this.entities[target];
    return objectSuggestedVerb(object, list(this.ui.verb_panel.verbs), this.game.protocol.look_verb);
  }
  scrollInventoryToEnd() {
    const spec = this.ui.inventory_panel, origin = tuple(spec.origin, 2, "inventory"), itemWidth = integer(spec.item_width, "item width"), arrowWidth = integer(spec.arrow_width || "16", "arrow width");
    const columns = Math.max(1, Math.floor((this.width - origin[0] - arrowWidth) / itemWidth));
    this.inventoryRow = inventoryLastRow(this.inventory.length, columns);
  }
  verbSentence(verb, first, second) { return verbSentence(this.ui, (id) => this.label(id), verb, first, second); }
  dismissMessage() { this.message = ""; this.messageTicks = 0; this.messageKind = ""; if (!this.queue.length) this.actionSentence = ""; }
  clearSelection() { this.activeVerb = null; this.firstObject = null; }
  bounds(entity) { const spec = this.graphics[`graphic.${entity.graphic}`], baseSize = tuple(entity.size || `${spec.width},${spec.height}`, 2, entity.id), baseOrigin = entity.origin ? tuple(entity.origin, 2, `${entity.id}.origin`) : [baseSize[0] / 2, baseSize[1] / 2], scale = entity.id === this.game.protocol.player_actor ? interpolatedScale(entity.position[1], this.playerScaling) : 1, size = baseSize.map((value) => value * scale), origin = baseOrigin.map((value) => value * scale); return [entity.position[0] - origin[0], entity.position[1] - origin[1], ...size]; }
  animationDuration(action, facing) { const animation = this.animations[`animation.${action}_${facing || "down"}`]; if (!animation?.frames) return 1; return animation.frames.split(";").reduce((sum, frame) => sum + tuple(frame.trim(), 5, "animation frame")[4], 0); }
  frame(now) { if (now - this.last >= 1000 / integer(this.game.runtime.ticks_per_second, "tick rate")) { this.step(); this.last = now; } this.draw(this.sceneSnapshot()); requestAnimationFrame((time) => this.frame(time)); }
  draw(scene) {
    const c = this.ctx, room = this.rooms[scene.room], background = room?.room.background_color || "#000";
    c.fillStyle = background; c.fillRect(0, 0, this.width, this.height);
    c.save(); const [shakeX, shakeY] = shakeOffset(this.shakeTicks, integer(this.game.runtime.shake_amplitude || "2", "shake amplitude")); c.translate(shakeX, shakeY);
    c.fillStyle = background; c.fillRect(0, 0, this.width, this.height);
    const backgroundImage = room?.room.background_image;
    if (backgroundImage) {
      const bitmap = this.bitmaps[backgroundImage];
      if (!bitmap) throw new Error(`${scene.room}.room.background_image references unknown graphic ${backgroundImage}`);
      nearestNeighbor(c).drawImage(bitmap, 0, 0, this.width, this.height);
    }
    if (room) for (const entity of entityRenderOrder(scene.entities)) if (entity.visible !== "false") this.sprite(entity);
    if (room && (room.room.hotspot_overlay === "true" || this.game.runtime.hotspot_overlay === "true")) this.drawHotspots();
    if (!this.interfaceVisible) { c.restore(); return; }
    const inventory = this.inventoryLayout();
    for (const [i, id] of scene.inventory.slice(inventory.page.start, inventory.page.end).entries()) this.sprite({ ...scene.inventoryEntities[id], ...this.items[id], visible: "true", position: [inventory.origin[0] + i * inventory.itemWidth, inventory.origin[1]], origin: "0,0", size: `${inventory.itemWidth},${inventory.itemHeight}` });
    this.inventoryArrow(inventory.upRect, "up", inventory.page.up); this.inventoryArrow(inventory.downRect, "down", inventory.page.down);
    this.textRegion(this.ui.message_region, scene.messageKind === "narrate" ? scene.message : "");
    if (scene.messageKind === "say") this.speech(scene.entities[this.game.protocol.player_actor], scene.message);
    const hoverTarget = this.hoverTarget === this.firstObject ? null : this.hoverTarget;
    const hoverSentence = hoverTarget ? (this.activeVerb ? this.verbSentence(this.activeVerb, this.firstObject || hoverTarget, this.firstObject ? hoverTarget : null) : (this.inventory.includes(hoverTarget) ? this.label(hoverTarget) : this.phrase("walk_to", { target: this.label(hoverTarget) }))) : "";
    const composing = this.activeVerb ? [title(this.activeVerb), this.firstObject && this.label(this.firstObject), this.firstObject && this.ui[`verb.${this.activeVerb}`]?.object_preposition].filter(Boolean).join(" ") : "";
    const walking = this.queue[0]?.op === "walk" ? this.phrase("walk_to", { target: this.label(this.queue[0].target) }) : "";
    this.textRegion(this.ui.sentence_region, scene.actionSentence || walking || hoverSentence || composing);
    const suggestedVerb = hoverTarget ? this.suggestedVerb(hoverTarget) : null;
    for (const verb of list(this.ui.verb_panel.verbs)) { const spec = this.ui[`verb.${verb}`]; this.panel(spec.rect, spec.label, this.activeVerb === verb, suggestedVerb === verb); }
    if (this.coarsePointer) this.cursor(this.touchCursor);
    c.restore();
  }
  label(id) { return (this.inventory.includes(id) ? this.items[id]?.label : this.entities[id]?.label) || this.inventoryEntities[id]?.label || id?.replaceAll("_", " ") || ""; }
  sprite(entity) {
    const [x, y, w, h] = this.bounds(entity), graphic = this.graphics[`graphic.${entity.graphic}`], bitmap = this.bitmaps[entity.graphic], animation = entity.id === this.game.protocol.player_actor ? this.animations[`animation.${entity.action || (entity.moving ? "walking" : "idle")}_${entity.facing || "down"}`] : graphic;
    if (bitmap) { this.drawBitmap(entity, bitmap, animation?.frames ? this.currentFrame(entity) : null, x, y, w, h); return; }
    this.ctx.fillStyle = this.graphics[`graphic.${entity.graphic}`]?.missing_color || "#ff00ff"; this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }
  currentFrame(entity) {
    const animation = entity.id === this.game.protocol.player_actor ? this.animations[`animation.${entity.action || (entity.moving ? "walking" : "idle")}_${entity.facing || "down"}`] : this.graphics[`graphic.${entity.graphic}`];
    if (!animation?.frames) return null;
    const frames = animation.frames.split(";").map((frame) => tuple(frame.trim(), 5, "animation frame")), cycle = frames.reduce((sum, frame) => sum + frame[4], 0);
    let phase = entity.action ? Math.max(0, cycle - entity.actionTicks) % cycle : this.tick % cycle;
    for (const frame of frames) { if (phase < frame[4]) return frame.slice(0, 4); phase -= frame[4]; }
    return frames[0].slice(0, 4);
  }
  drawHotspots() {
    const c = this.ctx; c.save(); c.strokeStyle = "#00ffff"; c.fillStyle = "#00ffff"; c.font = "8px monospace"; c.textBaseline = "bottom";
    for (const entity of entityRenderOrder(this.entities)) { const hotspot = entityHotspot(entity); if (!hotspot) continue; c.beginPath(); let labelPoint;
      if (hotspot.kind === "rect") { c.rect(...hotspot.points); labelPoint = hotspot.points; }
      else { hotspot.points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); labelPoint = hotspot.points[0]; }
      c.stroke(); c.fillText(`${entity.id}${entity.hotspot_priority ? ` (${entity.hotspot_priority})` : ""}`, labelPoint[0], labelPoint[1]);
    } c.restore();
  }
  drawBitmap(entity, bitmap, source, x, y, w, h) {
    const angle = Number(entity.rotation || 0) * Math.PI / 180, args = source ? [bitmap, ...source, -w / 2, -h / 2, w, h] : [bitmap, -w / 2, -h / 2, w, h];
    this.ctx.save(); this.ctx.translate(Math.round(x + w / 2), Math.round(y + h / 2)); if (angle) this.ctx.rotate(angle); nearestNeighbor(this.ctx).drawImage(...args); this.ctx.restore();
  }
  textRegion(spec, text) { const [x, y, w, h] = tuple(spec.rect, 4, "text region"), padding = integer(spec.padding || "4", "text padding"); this.ctx.fillStyle = this.ui.palette.panel; this.ctx.fillRect(x, y, w, h); this.ctx.fillStyle = this.ui.palette.text; this.ctx.font = this.ui.interface.font; this.ctx.textAlign = "left"; this.ctx.textBaseline = "middle"; this.ctx.fillText(text || "", x + padding, y + h / 2, w - padding * 2); }
  speech(actor, text) {
    if (!actor || !text) return;
    const spec = this.ui.speech || {}, padding = integer(spec.padding || "3", "speech padding"), margin = integer(spec.screen_margin || "2", "speech margin"), gap = integer(spec.actor_gap || "3", "speech actor gap");
    this.ctx.font = this.ui.interface.font;
    const width = Math.min(this.width - margin * 2, Math.ceil(this.ctx.measureText(text).width) + padding * 2), height = integer(spec.height || "14", "speech height");
    const actorBounds = this.bounds(actor), center = actorBounds[0] + actorBounds[2] / 2;
    const x = Math.max(margin, Math.min(this.width - margin - width, Math.round(center - width / 2))), y = Math.max(margin, Math.round(actorBounds[1] - gap - height));
    this.ctx.fillStyle = spec.background || this.ui.palette.panel; this.ctx.fillRect(x, y, width, height);
    this.ctx.fillStyle = spec.text || this.ui.palette.text; this.ctx.textAlign = "center"; this.ctx.textBaseline = "middle"; this.ctx.fillText(text, x + width / 2, y + height / 2, width - padding * 2);
  }
  panel(rect, label, active, suggested = false) { const [x, y, w, h] = tuple(rect, 4, "panel"); this.ctx.fillStyle = active ? this.ui.palette.active : suggested ? (this.ui.palette.suggested || this.ui.palette.panel) : this.ui.palette.panel; this.ctx.fillRect(x, y, w, h); this.ctx.strokeStyle = this.ui.palette.border; this.ctx.strokeRect(x + .5, y + .5, w - 1, h - 1); this.ctx.strokeStyle = this.ui.palette.shadow; this.ctx.beginPath(); this.ctx.moveTo(x + 2, y + h - 2); this.ctx.lineTo(x + w - 2, y + h - 2); this.ctx.lineTo(x + w - 2, y + 2); this.ctx.stroke(); this.ctx.fillStyle = this.ui.palette.text; this.ctx.font = this.ui.interface.font; this.ctx.textAlign = "left"; this.ctx.textBaseline = "middle"; this.ctx.fillText(label, x + 5, y + h / 2); }
  inventoryArrow(rect, direction, enabled) {
    const [x, y, w, h] = rect, centerX = x + w / 2, centerY = y + h / 2, sign = direction === "up" ? -1 : 1;
    this.ctx.fillStyle = this.ui.palette.panel; this.ctx.fillRect(x, y, w, h); this.ctx.strokeStyle = this.ui.palette.border; this.ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
    this.ctx.fillStyle = enabled ? this.ui.palette.text : (this.ui.palette.disabled || "#687080"); this.ctx.beginPath(); this.ctx.moveTo(centerX, centerY + sign * 4); this.ctx.lineTo(centerX - 5, centerY + sign * -3); this.ctx.lineTo(centerX + 5, centerY + sign * -3); this.ctx.closePath(); this.ctx.fill();
  }
  cursor([x, y]) {
    const c = this.ctx; c.save(); c.translate(Math.round(x) + .5, Math.round(y) + .5); c.strokeStyle = "#fff"; c.fillStyle = "#101b34"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(0, 12); c.lineTo(3, 9); c.lineTo(6, 15); c.lineTo(9, 13); c.lineTo(6, 8); c.lineTo(11, 8); c.closePath(); c.fill(); c.stroke(); c.restore();
  }
}
const inside = (x, y, [bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh;
const title = (value) => value[0].toUpperCase() + value.slice(1);
if (root && entry) boot().catch((error) => { root.textContent = `Cannot start game: ${error.message}`; root.ariaBusy = "false"; console.error(error); });
