import { parseIni, integer, tuple, list } from "./ini.js";
import { compile, instantiate } from "./script.js";
import { resolvePackagePath } from "./path.js";
import { loadBitmaps } from "./bitmaps.js";

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
  const script = compile(await fetchText(resolvePackagePath(base, game.package.entry_script)));
  const rooms = Object.create(null);
  for (const id of list(roomsIndex.catalogue.rooms)) rooms[id] = parseIni(await fetchText(resolvePackagePath(base, roomsIndex[`room.${id}`].path)));
  new Runtime(game, ui, rooms, graphics, animations, bitmaps, script).start();
}

class Runtime {
  constructor(game, ui, rooms, graphics, animations, bitmaps, handlers) {
    Object.assign(this, { game, ui, rooms, graphics, animations, bitmaps, handlers });
    this.entities = Object.create(null); this.inventory = []; this.inventoryEntities = Object.create(null);
    this.activeVerb = null; this.firstObject = null; this.queue = []; this.message = ""; this.messageKind = ""; this.messageTicks = 0; this.sentence = ""; this.tick = 0;
    this.width = integer(game.display.logical_width, "logical_width"); this.height = integer(game.display.logical_height, "logical_height");
    this.canvas = document.createElement("canvas"); this.canvas.width = this.width; this.canvas.height = this.height;
    const aspect = this.width / this.height;
    this.canvas.style.aspectRatio = `${this.width} / ${this.height}`; this.canvas.style.setProperty("--game-width", `min(100vw, ${aspect * 100}vh)`); this.canvas.style.setProperty("--game-height", `min(100vh, ${100 / aspect}vw)`);
    this.canvas.setAttribute("aria-label", ui.interface.accessible_label); this.canvas.tabIndex = 0; this.ctx = this.canvas.getContext("2d"); this.ctx.imageSmoothingEnabled = false;
    root.replaceChildren(this.canvas); root.ariaBusy = "false";
  }
  start() {
    this.dispatch("game.start", []);
    this.canvas.addEventListener("pointerdown", (event) => this.pointer(event));
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("keydown", (event) => { if (event.key === "Escape") this.clearSelection(); });
    this.canvas.focus(); this.last = performance.now(); requestAnimationFrame((now) => this.frame(now));
  }
  dispatch(event, args) { const handler = this.handlers.find((candidate) => candidate.event === event && candidate.args.length === args.length); if (handler) this.queue.push(...instantiate(handler, args)); }
  enter(id, spawn) {
    const room = this.rooms[id]; if (!room) throw new Error(`Unknown room ${id}`); this.room = id; this.entities = Object.create(null);
    for (const [section, values] of Object.entries(room)) if (section.startsWith("entity.")) this.entities[section.slice(7)] = { id: section.slice(7), ...values, position: tuple(values.position, 2, `${section}.position`) };
    const point = tuple(room[`spawn.${spawn}`].position, 2, "spawn"); this.entities.player = { id: "player", position: point, graphic: "placeholder.actor", size: "16,32", label: "player", visible: "true", facing: "down", moving: false };
  }
  pointer(event) {
    event.preventDefault();
    if (event.button === 2) this.clearSelection();
    if (this.message) { this.dismissMessage(); return; }
    const rect = this.canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * this.width / rect.width, y = (event.clientY - rect.top) * this.height / rect.height;
    if (event.button === 0) for (const verb of list(this.ui.verb_panel.verbs)) { const box = tuple(this.ui[`verb.${verb}`].rect, 4, verb); if (inside(x, y, box)) { this.activeVerb = verb; this.firstObject = null; return; } }
    const target = this.targetAt(x, y);
    if (event.button === 2) { this.perform("look", target); return; }
    if (event.button !== 0) return;
    if (!this.activeVerb) { this.queue = [{ op: "walk", actor: "player", point: [Math.round(x), Math.round(y)], manual: true }]; this.sentence = "Walk to"; return; }
    if (this.activeVerb === "use") {
      if (!this.firstObject && target) { this.firstObject = target; return; }
      if (target) { this.sentence = `Use ${this.label(this.firstObject)} on ${this.label(target)}`; this.dispatch("entity.use_item", [this.firstObject, target]); }
    } else this.perform(this.activeVerb, target);
    this.clearSelection();
  }
  targetAt(x, y) {
    const origin = tuple(this.ui.inventory_panel.origin, 2, "inventory"), itemWidth = integer(this.ui.inventory_panel.item_width, "item width"), itemHeight = integer(this.ui.inventory_panel.item_height, "item height");
    return this.inventory.find((id, i) => inside(x, y, [origin[0] + i * itemWidth, origin[1], itemWidth, itemHeight])) || Object.values(this.entities).reverse().find((entity) => entity.id !== "player" && entity.visible !== "false" && inside(x, y, this.bounds(entity)))?.id;
  }
  perform(verb, target) { if (!target) return; this.sentence = `${title(verb)} ${this.label(target)}`; this.dispatch(`entity.${verb}`, [target]); }
  dismissMessage() { this.message = ""; this.messageTicks = 0; this.messageKind = ""; this.sentence = ""; }
  clearSelection() { this.activeVerb = null; this.firstObject = null; }
  bounds(entity) { const spec = this.graphics[`graphic.${entity.graphic}`], size = tuple(entity.size || `${spec.width},${spec.height}`, 2, entity.id); return [entity.position[0], entity.position[1], ...size]; }
  step() {
    this.tick++;
    if (this.message) { if (--this.messageTicks <= 0) this.dismissMessage(); return; }
    const command = this.queue[0]; if (!command) return;
    if (command.op === "walk") { const actor = this.entities[command.actor], target = command.point || this.entities[command.target]?.position; if (!actor || !target) return void this.queue.shift(); const dx = target[0] - actor.position[0], dy = target[1] - actor.position[1], distance = Math.hypot(dx, dy); actor.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down"); actor.moving = distance > 1.5; if (distance <= 1.5) { actor.position = [...target]; actor.moving = false; this.queue.shift(); } else actor.position = [actor.position[0] + dx / distance * 1.5, actor.position[1] + dy / distance * 1.5]; return; }
    this.queue.shift();
    if (command.op === "enter") this.enter(command.room, command.spawn);
    else if (command.op === "say" || command.op === "narrate") { this.message = command.value; this.messageKind = command.op; this.messageTicks = integer(this.game.runtime.text_duration_ticks, "text duration"); }
    else if (command.op === "take") { const entity = this.entities[command.target]; if (entity && !this.inventory.includes(command.target)) { entity.visible = "false"; this.inventoryEntities[command.target] = { ...entity }; this.inventory.push(command.target); } }
    else if (command.op === "hide" || command.op === "show") this.entities[command.target].visible = command.op === "show" ? "true" : "false";
    else if (command.op === "set") { const [id, field] = command.target.split("."); if (id === "game") this[id] ??= {}, this[id][field] = command.value; else this.entities[id][field] = String(command.value); }
    else if (command.op === "wait") this.queue.unshift(...Array(command.ticks).fill({ op: "pause" }));
    else if (command.op === "pause") return;
    else if (command.op === "face") this.entities[command.actor].facing = command.direction;
  }
  frame(now) { if (now - this.last >= 1000 / integer(this.game.runtime.ticks_per_second, "tick rate")) { this.step(); this.last = now; } this.draw(); requestAnimationFrame((time) => this.frame(time)); }
  draw() {
    const c = this.ctx, room = this.rooms[this.room]; c.fillStyle = room?.room.background_color || "#000"; c.fillRect(0, 0, this.width, this.height);
    if (room) for (const entity of Object.values(this.entities)) if (entity.visible !== "false") this.sprite(entity);
    const origin = tuple(this.ui.inventory_panel.origin, 2, "inventory"), itemWidth = integer(this.ui.inventory_panel.item_width, "item width");
    for (const [i, id] of this.inventory.entries()) this.sprite({ ...this.inventoryEntities[id], visible: "true", position: [origin[0] + i * itemWidth, origin[1]], size: `${itemWidth},${this.ui.inventory_panel.item_height}` });
    this.textRegion(this.ui.message_region, this.messageKind === "narrate" ? this.message : "");
    if (this.messageKind === "say") this.speech(this.entities.player, this.message);
    const composing = this.activeVerb ? [title(this.activeVerb), this.firstObject && this.label(this.firstObject), this.activeVerb === "use" && this.firstObject && "on"].filter(Boolean).join(" ") : ""; this.textRegion(this.ui.sentence_region, (this.queue.length || this.message) && this.sentence ? this.sentence : composing);
    for (const verb of list(this.ui.verb_panel.verbs)) { const spec = this.ui[`verb.${verb}`]; this.panel(spec.rect, spec.label, this.activeVerb === verb); }
  }
  label(id) { return this.entities[id]?.label || this.inventoryEntities[id]?.label || id?.replaceAll("_", " ") || ""; }
  sprite(entity) {
    const [x, y, w, h] = this.bounds(entity), graphic = this.graphics[`graphic.${entity.graphic}`], bitmap = this.bitmaps[entity.graphic], animation = entity.id === "player" ? this.animations[`animation.${entity.moving ? "walking" : "idle"}_${entity.facing || "down"}`] : graphic;
    if (bitmap) { if (animation?.frames) { const frames = animation.frames.split(";").map((frame) => tuple(frame.trim(), 5, "animation frame")), cycle = frames.reduce((sum, frame) => sum + frame[4], 0); let phase = this.tick % cycle, selected = frames[0]; for (const frame of frames) { if (phase < frame[4]) { selected = frame; break; } phase -= frame[4]; } this.ctx.drawImage(bitmap, ...selected.slice(0, 4), Math.round(x), Math.round(y), w, h); } else this.ctx.drawImage(bitmap, Math.round(x), Math.round(y), w, h); return; }
    this.ctx.fillStyle = this.graphics[`graphic.${entity.graphic}`]?.missing_color || "#ff00ff"; this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
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
}
const inside = (x, y, [bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh;
const title = (value) => value[0].toUpperCase() + value.slice(1);
boot().catch((error) => { root.textContent = `Cannot start game: ${error.message}`; root.ariaBusy = "false"; console.error(error); });
