import { parseIni, integer, tuple, list } from "./ini.js";
import { compile, instantiate, textDuration } from "./script.js";
import { resolvePackagePath } from "./path.js";
import { loadBitmaps } from "./bitmaps.js";
import { bitmapWalkRegion, dragCursor, enteredTriggers, entityIsInteractive, entityRenderOrder, interfacePoint, interpolatedScale, inventoryLastRow, inventoryPage, parseScalingStops, prepareItemUse, retainedRoomEntities, roomEntryItems, shakeOffset, touchMoved, verbSentence } from "./interaction.js";

const root = document.querySelector("#engine-host");
const entry = document.querySelector('meta[name="game-entry"]')?.content;
const fetchText = async (path) => { const response = await fetch(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };

async function boot() {
  const game = parseIni(await fetchText(entry), entry);
  const base = entry.slice(0, entry.lastIndexOf("/") + 1);
  const resourceCataloguePath = resolvePackagePath(base, game.package.resource_catalogue);
  const resourceBase = resourceCataloguePath.slice(0, resourceCataloguePath.lastIndexOf("/") + 1);
  const resources = parseIni(await fetchText(resourceCataloguePath));
  const ui = parseIni(await fetchText(resolvePackagePath(base, game.package.interface)));
  const roomsIndex = parseIni(await fetchText(resolvePackagePath(base, game.package.room_catalogue)));
  const graphicsPath = resources.catalogue.graphics || game.package.graphics;
  const graphics = parseIni(await fetchText(resolvePackagePath(resourceBase, graphicsPath)));
  const animations = parseIni(await fetchText(resolvePackagePath(resourceBase, resources.catalogue.player_animations)));
  const bitmaps = await loadBitmaps(graphics, resourceBase);
  const handlers = compile(await fetchText(resolvePackagePath(base, game.package.entry_script)));
  const rooms = Object.create(null);
  for (const id of list(roomsIndex.catalogue.rooms)) {
    const spec = roomsIndex[`room.${id}`];
    rooms[id] = parseIni(await fetchText(resolvePackagePath(base, spec.path)));
    const entities = Object.keys(rooms[id]).filter((section) => section.startsWith("entity.")).map((section) => section.slice(7));
    handlers.push(...compile(await fetchText(resolvePackagePath(base, spec.script)), { roomId: id, entities }));
  }
  const items = Object.create(null);
  if (game.package.item_catalogue) {
    const itemPath = resolvePackagePath(base, game.package.item_catalogue), itemIndex = parseIni(await fetchText(itemPath));
    const itemBase = itemPath.slice(0, itemPath.lastIndexOf("/") + 1);
    for (const id of list(itemIndex.catalogue.items)) {
      items[id] = itemIndex[`item.${id}`];
      const script = items[id].script;
      if (script) handlers.push(...compile(await fetchText(resolvePackagePath(itemBase, script)), { itemId: id }));
    }
  }
  new Runtime(game, ui, rooms, items, graphics, animations, bitmaps, handlers).start();
}

class Runtime {
  constructor(game, ui, rooms, items, graphics, animations, bitmaps, handlers) {
    Object.assign(this, { game, ui, rooms, items, graphics, animations, bitmaps, handlers });
    this.entities = Object.create(null); this.roomEntities = Object.create(null); this.inventory = []; this.inventoryEntities = Object.create(null); this.globals = { ...game.$variables };
    this.roomState = Object.fromEntries(Object.entries(rooms).map(([id, room]) => [id, { ...room.$variables }]));
    this.activeVerb = null; this.firstObject = null; this.hoverTarget = null; this.queue = []; this.message = ""; this.messageKind = ""; this.messageTicks = 0; this.actionSentence = ""; this.tick = 0; this.shakeTicks = 0; this.inventoryRow = 0;
    this.width = integer(game.display.logical_width, "logical_width"); this.height = integer(game.display.logical_height, "logical_height");
    this.canvas = document.createElement("canvas"); this.canvas.width = this.width; this.canvas.height = this.height;
    const aspect = this.width / this.height;
    const safeWidth = "(100dvw - env(safe-area-inset-left) - env(safe-area-inset-right))", safeHeight = "(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))";
    this.canvas.style.aspectRatio = `${this.width} / ${this.height}`; this.canvas.style.setProperty("--game-width", `min(calc${safeWidth}, calc(${safeHeight} * ${aspect}))`); this.canvas.style.setProperty("--game-height", `min(calc${safeHeight}, calc(${safeWidth} / ${aspect}))`);
    this.canvas.setAttribute("aria-label", ui.interface.accessible_label); this.canvas.tabIndex = 0; this.ctx = this.canvas.getContext("2d"); this.ctx.imageSmoothingEnabled = false;
    this.coarsePointer = matchMedia("(pointer: coarse)").matches;
    this.cursorMode = localStorage.getItem("anachronist.cursor-mode") || "direct";
    this.draggingSensitivity = Number(game.input.dragging_sensitivity);
    if (!Number.isFinite(this.draggingSensitivity) || this.draggingSensitivity <= 0) throw new Error("dragging_sensitivity must be a positive number");
    this.longTouchMilliseconds = integer(game.input.long_touch_milliseconds, "long touch milliseconds");
    this.longTouchMoveTolerance = Number(game.input.long_touch_move_tolerance ?? 8);
    if (!Number.isFinite(this.longTouchMoveTolerance) || this.longTouchMoveTolerance < 0) throw new Error("long_touch_move_tolerance must be a non-negative number");
    this.touchCursor = [this.width / 2, this.height / 2]; this.touch = null;
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
    this.canvas.addEventListener("keydown", (event) => { if (event.key === "Escape") this.clearSelection(); });
    this.canvas.focus(); this.last = performance.now(); requestAnimationFrame((now) => this.frame(now));
  }
  settings() {
    const wrapper = document.createElement("div"); wrapper.className = "mobile-settings"; wrapper.hidden = !this.coarsePointer;
    const button = document.createElement("button"); button.type = "button"; button.textContent = "⚙"; button.ariaLabel = "Touch settings"; button.ariaExpanded = "false";
    const choices = document.createElement("fieldset"); choices.hidden = true;
    const legend = document.createElement("legend"); legend.textContent = "Touch cursor"; choices.append(legend);
    for (const [value, label] of [["direct", "Point where I touch"], ["drag", "Drag cursor"]]) {
      const row = document.createElement("label"), radio = document.createElement("input"); radio.type = "radio"; radio.name = "cursor-mode"; radio.value = value; radio.checked = this.cursorMode === value;
      radio.addEventListener("change", () => { this.cursorMode = value; localStorage.setItem("anachronist.cursor-mode", value); });
      row.append(radio, ` ${label}`); choices.append(row);
    }
    const fullscreen = document.createElement("button"); fullscreen.type = "button"; fullscreen.className = "fullscreen-toggle"; fullscreen.textContent = "Enter full screen";
    fullscreen.hidden = !document.fullscreenEnabled; fullscreen.addEventListener("click", () => this.toggleFullscreen());
    document.addEventListener("fullscreenchange", () => { fullscreen.textContent = document.fullscreenElement ? "Exit full screen" : "Enter full screen"; });
    choices.append(fullscreen);
    button.addEventListener("click", () => { choices.hidden = !choices.hidden; button.ariaExpanded = String(!choices.hidden); });
    wrapper.append(button, choices); return wrapper;
  }
  async toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen(); screen.orientation?.unlock?.(); return;
    }
    await root.requestFullscreen({ navigationUI: "hide" });
    await screen.orientation?.lock?.("landscape").catch(() => {});
  }
  scriptState() { return { game: this.globals, ...this.roomState }; }
  matchingHandler(event, args) { return this.handlers.find((candidate) => candidate.event === event && candidate.args.length === args.length && (!candidate.roomId || candidate.roomId === this.room) && (!candidate.localTarget || candidate.localTarget === args.at(-1))); }
  dispatch(event, args) { const handler = this.matchingHandler(event, args); if (!handler) return 0; const commands = instantiate(handler, args, this.scriptState()); this.queue.push(...commands); return commands.length; }
  commands(event, args) { const handler = this.matchingHandler(event, args); return handler ? instantiate(handler, args, this.scriptState()) : null; }
  enter(id, spawn) {
    const room = this.rooms[id]; if (!room) throw new Error(`Unknown room ${id}`); this.room = id;
    this.interactive = room.room.interactive !== "false";
    this.interfaceVisible = room.room.interface_visible !== "false" && room.room.fullscreen !== "true";
    this.playerScaling = parseScalingStops(room.room.player_scaling || "0,1; 1,1", `${id}.room.player_scaling`);
    const mask = room.room.walk_mask;
    this.walkable = mask ? bitmapWalkRegion(this.bitmaps[mask], this.width, this.height) : () => true;
    this.entities = retainedRoomEntities(this.roomEntities, id, () => {
      const entities = Object.create(null);
      for (const [section, values] of Object.entries(room)) if (section.startsWith("entity.")) entities[section.slice(7)] = { id: section.slice(7), ...values, position: tuple(values.position, 2, `${section}.position`) };
      return entities;
    });
    for (const item of roomEntryItems(room)) if (!this.inventory.includes(item.id)) {
      this.inventory.push(item.id); this.inventoryEntities[item.id] = { ...item, visible: "false", position: [0, 0] };
    }
    const point = tuple(room[`spawn.${spawn}`].position, 2, "spawn"), player = this.animations.player || {}; this.entities.player = { id: "player", position: point, graphic: player.graphic || "placeholder.actor", size: player.size || "16,32", origin: player.origin, label: "player", visible: room.room.player_visible === "false" ? "false" : "true", facing: "down", moving: false, action: null, actionTicks: 0 };
    this.triggers = Object.fromEntries(Object.entries(room).filter(([section]) => section.startsWith("trigger.")).map(([section, values]) => [section.slice(8), tuple(values.rect, 4, `${section}.rect`)]));
    // A spawn may deliberately overlap a destination trigger. Treat it as
    // occupied until the player leaves, rather than immediately bouncing back.
    this.occupiedTriggers = enteredTriggers(point, this.triggers).occupied;
    this.dispatch("room.enter", [id]);
  }
  eventPoint(event) { const rect = this.canvas.getBoundingClientRect(); return [(event.clientX - rect.left) * this.width / rect.width, (event.clientY - rect.top) * this.height / rect.height]; }
  hover(event) { const [x, y] = this.eventPoint(event); this.updateHover(x, y); }
  updateHover(x, y) {
    const target = this.targetAt(x, y);
    this.hoverTarget = interfacePoint(x, y, this.ui, this.width, this.height) && !this.activeVerb && !this.inventory.includes(target) ? null : target;
  }
  pointerDown(event) {
    if (event.target.closest?.(".mobile-settings")) return;
    if (event.pointerType !== "touch") { if (event.target === this.canvas) this.pointer(event); return; }
    if (this.cursorMode !== "drag" && event.target !== this.canvas) return;
    if (this.touch) return;
    event.preventDefault(); root.setPointerCapture(event.pointerId);
    const point = this.eventPoint(event); if (this.cursorMode === "direct") this.touchCursor = point;
    this.touch = { id: event.pointerId, start: point, last: point, moved: false, long: false, startedAt: performance.now() };
    const pointerId = event.pointerId;
    this.touch.timer = setTimeout(() => { if (this.touch?.id !== pointerId || this.touch.moved) return; this.touch.long = true; this.pointer(event, 2, this.touchCursor); }, this.longTouchMilliseconds);
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
      this.pointer(event, button, this.touchCursor);
    }
    this.touch = null;
  }
  cancelTouch(event) { if (this.touch?.id === event.pointerId) { clearTimeout(this.touch.timer); this.touch = null; } }
  pointer(event, button = event.button, point = this.eventPoint(event)) {
    event.preventDefault();
    if (!this.interactive) return;
    if (button === 2) this.clearSelection();
    const [x, y] = point;
    if (button === 0) {
      const inventory = this.inventoryLayout();
      if (inside(x, y, inventory.upRect) && inventory.page.up) { this.inventoryRow--; return; }
      if (inside(x, y, inventory.downRect) && inventory.page.down) { this.inventoryRow++; return; }
    }
    let selectedVerb = null;
    if (button === 0) for (const verb of list(this.ui.verb_panel.verbs)) { const box = tuple(this.ui[`verb.${verb}`].rect, 4, verb); if (inside(x, y, box)) { selectedVerb = verb; break; } }
    if (this.message) {
      this.dismissMessage();
      // A verb click still advances dialogue, but becomes a selection when it
      // closed the final piece of text in the current command chain.
      if (selectedVerb && !this.queue.some(({ op }) => op === "say" || op === "narrate")) { this.activeVerb = selectedVerb; this.firstObject = null; }
      return;
    }
    if (selectedVerb) { this.stopWalking(); this.activeVerb = selectedVerb; this.firstObject = null; return; }
    const target = this.targetAt(x, y);
    if (button === 2) { this.perform("look", target); return; }
    if (button !== 0) return;
    if (interfacePoint(x, y, this.ui, this.width, this.height) && !target) return;
    if (!this.activeVerb && this.inventory.includes(target)) return;
    if (!this.activeVerb) {
      this.interruptCommands(); this.actionSentence = target ? `Walk to ${this.label(target)}` : "Walk to";
      if (!target) this.queue = [{ op: "walk", actor: "player", point: [Math.round(x), Math.round(y)], manual: true }];
      else if (!this.dispatch("entity.walk", [target])) this.queue = [{ op: "walk", actor: "player", target, manual: true }];
      return;
    }
    if (this.activeVerb === "use") {
      if (!this.firstObject && target) { this.firstObject = target; this.hoverTarget = null; return; }
      else if (target) {
        this.interruptCommands(); this.actionSentence = this.verbSentence("use", this.firstObject, target);
        const commands = this.commands("entity.use_item", [this.firstObject, target]);
        const prepared = commands && prepareItemUse(commands, this);
        if (prepared) this.queue.push(...prepared);
      }
    } else this.perform(this.activeVerb, target);
    this.clearSelection();
  }
  interruptCommands() { this.queue = []; const player = this.entities.player; if (player) { player.moving = false; player.action = null; player.actionTicks = 0; } }
  stopWalking() {
    const command = this.queue[0];
    if (command?.op !== "walk") return;
    this.queue = [];
    const actor = this.entities[command.actor];
    if (actor) actor.moving = false;
    this.actionSentence = "";
  }
  targetAt(x, y) {
    const layout = this.inventoryLayout();
    const inventoryTarget = this.inventory.slice(layout.page.start, layout.page.end).find((id, i) => id !== this.firstObject && inside(x, y, [layout.origin[0] + i * layout.itemWidth, layout.origin[1], layout.itemWidth, layout.itemHeight]));
    return inventoryTarget || entityRenderOrder(this.entities).reverse().find((entity) => entity.id !== "player" && entity.id !== this.firstObject && entityIsInteractive(entity) && inside(x, y, this.bounds(entity)))?.id;
  }
  inventoryLayout() {
    const spec = this.ui.inventory_panel, origin = tuple(spec.origin, 2, "inventory"), itemWidth = integer(spec.item_width, "item width"), itemHeight = integer(spec.item_height, "item height"), arrowWidth = integer(spec.arrow_width || "16", "arrow width");
    const columns = Math.max(1, Math.floor((this.width - origin[0] - arrowWidth) / itemWidth)), page = inventoryPage(this.inventory.length, this.inventoryRow, columns); this.inventoryRow = page.row;
    return { origin, itemWidth, itemHeight, page, upRect: [this.width - arrowWidth, origin[1], arrowWidth, itemHeight / 2], downRect: [this.width - arrowWidth, origin[1] + itemHeight / 2, arrowWidth, itemHeight / 2] };
  }
  scrollInventoryToEnd() {
    const spec = this.ui.inventory_panel, origin = tuple(spec.origin, 2, "inventory"), itemWidth = integer(spec.item_width, "item width"), arrowWidth = integer(spec.arrow_width || "16", "arrow width");
    const columns = Math.max(1, Math.floor((this.width - origin[0] - arrowWidth) / itemWidth));
    this.inventoryRow = inventoryLastRow(this.inventory.length, columns);
  }
  perform(verb, target) { if (!target) return; this.interruptCommands(); this.actionSentence = this.verbSentence(verb, target); if (verb === "use") this.queue.push({ op: "animate", actor: "player", animation: "use" }); this.dispatch(`entity.${verb}`, [target]); }
  verbSentence(verb, first, second) { return verbSentence(this.ui, (id) => this.label(id), verb, first, second); }
  dismissMessage() { this.message = ""; this.messageTicks = 0; this.messageKind = ""; if (!this.queue.length) this.actionSentence = ""; }
  clearSelection() { this.activeVerb = null; this.firstObject = null; }
  bounds(entity) { const spec = this.graphics[`graphic.${entity.graphic}`], baseSize = tuple(entity.size || `${spec.width},${spec.height}`, 2, entity.id), baseOrigin = entity.origin ? tuple(entity.origin, 2, `${entity.id}.origin`) : [baseSize[0] / 2, baseSize[1] / 2], scale = entity.id === "player" ? interpolatedScale(entity.position[1], this.playerScaling) : 1, size = baseSize.map((value) => value * scale), origin = baseOrigin.map((value) => value * scale); return [entity.position[0] - origin[0], entity.position[1] - origin[1], ...size]; }
  step() {
    this.tick++;
    if (this.shakeTicks > 0) this.shakeTicks--;
    if (this.message) { if (--this.messageTicks <= 0) this.dismissMessage(); return; }
    const player = this.entities.player;
    if (player?.actionTicks > 0) { if (--player.actionTicks === 0) player.action = null; return; }
    const command = this.queue[0]; if (!command) { this.actionSentence = ""; return; }
    if (command.op === "walk") { const actor = this.entities[command.actor], target = command.point || this.entities[command.target]?.position; if (!actor || !target) return void this.queue.shift(); const speed = 2, dx = target[0] - actor.position[0], dy = target[1] - actor.position[1], distance = Math.hypot(dx, dy); actor.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down"); actor.moving = distance > speed; const next = distance <= speed ? [...target] : [actor.position[0] + dx / distance * speed, actor.position[1] + dy / distance * speed]; if (actor.id === "player" && !this.walkable(next)) { actor.moving = false; this.queue.shift(); this.actionSentence = ""; return; } actor.position = next; if (distance <= speed) { actor.moving = false; this.queue.shift(); } if (actor.id === "player") this.updateTriggers(actor.position); return; }
    this.queue.shift();
    if (command.op === "enter") this.enter(command.room, command.spawn);
    else if (command.op === "say" || command.op === "narrate") { this.message = command.value; this.messageKind = command.op; this.messageTicks = textDuration(command.value, this.game.runtime); }
    else if (command.op === "animate") { const actor = this.entities[command.actor]; if (actor) { actor.moving = false; actor.action = command.animation; actor.actionTicks = this.animationDuration(command.animation, actor.facing); } }
    else if (command.op === "take") { const entity = this.entities[command.target]; if (entity && !this.inventory.includes(command.target)) { if (!command.animated) { this.queue.unshift({ ...command, animated: true }); this.queue.unshift({ op: "animate", actor: "player", animation: "pickup" }); return; } entity.visible = "false"; this.inventoryEntities[command.target] = { ...this.items[command.target], ...entity }; this.inventory.push(command.target); this.scrollInventoryToEnd(); } }
    else if (command.op === "hide" || command.op === "show") this.entities[command.target].visible = command.op === "show" ? "true" : "false";
    else if (command.op === "set") { const [id, field] = command.target.split("."); if (id === "game") this.globals[field] = command.value; else if (this.roomState[id]) this.roomState[id][field] = command.value; else this.entities[id][field] = String(command.value); }
    else if (command.op === "wait") this.queue.unshift(...Array(command.ticks).fill({ op: "pause" }));
    else if (command.op === "shake") this.shakeTicks = command.ticks;
    else if (command.op === "pause") return;
    else if (command.op === "face") this.entities[command.actor].facing = command.direction;
  }
  updateTriggers(point) { const state = enteredTriggers(point, this.triggers, this.occupiedTriggers); this.occupiedTriggers = state.occupied; for (const id of state.entered) if (!this.queue.some(({ op }) => op === "enter")) this.dispatch("trigger.enter", [id]); }
  animationDuration(action, facing) { const animation = this.animations[`animation.${action}_${facing || "down"}`]; if (!animation?.frames) return 1; return animation.frames.split(";").reduce((sum, frame) => sum + tuple(frame.trim(), 5, "animation frame")[4], 0); }
  frame(now) { if (now - this.last >= 1000 / integer(this.game.runtime.ticks_per_second, "tick rate")) { this.step(); this.last = now; } this.draw(); requestAnimationFrame((time) => this.frame(time)); }
  draw() {
    const c = this.ctx, room = this.rooms[this.room], background = room?.room.background_color || "#000";
    c.fillStyle = background; c.fillRect(0, 0, this.width, this.height);
    c.save(); const [shakeX, shakeY] = shakeOffset(this.shakeTicks, integer(this.game.runtime.shake_amplitude || "2", "shake amplitude")); c.translate(shakeX, shakeY);
    c.fillStyle = background; c.fillRect(0, 0, this.width, this.height);
    if (room) for (const entity of entityRenderOrder(this.entities)) if (entity.visible !== "false") this.sprite(entity);
    if (!this.interfaceVisible) { c.restore(); return; }
    const inventory = this.inventoryLayout();
    for (const [i, id] of this.inventory.slice(inventory.page.start, inventory.page.end).entries()) this.sprite({ ...this.items[id], ...this.inventoryEntities[id], visible: "true", position: [inventory.origin[0] + i * inventory.itemWidth, inventory.origin[1]], origin: "0,0", size: `${inventory.itemWidth},${inventory.itemHeight}` });
    this.inventoryArrow(inventory.upRect, "up", inventory.page.up); this.inventoryArrow(inventory.downRect, "down", inventory.page.down);
    this.textRegion(this.ui.message_region, this.messageKind === "narrate" ? this.message : "");
    if (this.messageKind === "say") this.speech(this.entities.player, this.message);
    const hoverTarget = this.hoverTarget === this.firstObject ? null : this.hoverTarget;
    const hoverSentence = hoverTarget ? (this.activeVerb ? this.verbSentence(this.activeVerb, this.firstObject || hoverTarget, this.firstObject ? hoverTarget : null) : (this.inventory.includes(hoverTarget) ? this.label(hoverTarget) : `Walk to ${this.label(hoverTarget)}`)) : "";
    const composing = this.activeVerb ? [title(this.activeVerb), this.firstObject && this.label(this.firstObject), this.firstObject && this.ui[`verb.${this.activeVerb}`]?.object_preposition].filter(Boolean).join(" ") : "";
    const walking = this.queue[0]?.op === "walk" ? `Walk to ${this.label(this.queue[0].target)}` : "";
    this.textRegion(this.ui.sentence_region, this.actionSentence || walking || hoverSentence || composing);
    for (const verb of list(this.ui.verb_panel.verbs)) { const spec = this.ui[`verb.${verb}`]; this.panel(spec.rect, spec.label, this.activeVerb === verb); }
    if (this.coarsePointer) this.cursor(this.touchCursor);
    c.restore();
  }
  label(id) { return this.entities[id]?.label || this.inventoryEntities[id]?.label || id?.replaceAll("_", " ") || ""; }
  sprite(entity) {
    const [x, y, w, h] = this.bounds(entity), graphic = this.graphics[`graphic.${entity.graphic}`], bitmap = this.bitmaps[entity.graphic], animation = entity.id === "player" ? this.animations[`animation.${entity.action || (entity.moving ? "walking" : "idle")}_${entity.facing || "down"}`] : graphic;
    if (bitmap) { if (animation?.frames) { const frames = animation.frames.split(";").map((frame) => tuple(frame.trim(), 5, "animation frame")), cycle = frames.reduce((sum, frame) => sum + frame[4], 0); let phase = entity.action ? Math.max(0, cycle - entity.actionTicks) % cycle : this.tick % cycle, selected = frames[0]; for (const frame of frames) { if (phase < frame[4]) { selected = frame; break; } phase -= frame[4]; } this.drawBitmap(entity, bitmap, selected.slice(0, 4), x, y, w, h); } else this.drawBitmap(entity, bitmap, null, x, y, w, h); return; }
    this.ctx.fillStyle = this.graphics[`graphic.${entity.graphic}`]?.missing_color || "#ff00ff"; this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }
  drawBitmap(entity, bitmap, source, x, y, w, h) {
    const angle = Number(entity.rotation || 0) * Math.PI / 180, args = source ? [bitmap, ...source, -w / 2, -h / 2, w, h] : [bitmap, -w / 2, -h / 2, w, h];
    this.ctx.save(); this.ctx.translate(Math.round(x + w / 2), Math.round(y + h / 2)); if (angle) this.ctx.rotate(angle); this.ctx.drawImage(...args); this.ctx.restore();
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
  panel(rect, label, active) { const [x, y, w, h] = tuple(rect, 4, "panel"); this.ctx.fillStyle = active ? this.ui.palette.active : this.ui.palette.panel; this.ctx.fillRect(x, y, w, h); this.ctx.strokeStyle = this.ui.palette.border; this.ctx.strokeRect(x + .5, y + .5, w - 1, h - 1); this.ctx.strokeStyle = this.ui.palette.shadow; this.ctx.beginPath(); this.ctx.moveTo(x + 2, y + h - 2); this.ctx.lineTo(x + w - 2, y + h - 2); this.ctx.lineTo(x + w - 2, y + 2); this.ctx.stroke(); this.ctx.fillStyle = this.ui.palette.text; this.ctx.font = this.ui.interface.font; this.ctx.textAlign = "left"; this.ctx.textBaseline = "middle"; this.ctx.fillText(label, x + 5, y + h / 2); }
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
boot().catch((error) => { root.textContent = `Cannot start game: ${error.message}`; root.ariaBusy = "false"; console.error(error); });
