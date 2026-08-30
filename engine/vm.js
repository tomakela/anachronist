import { integer, list, tuple } from "./ini.js";
import { instantiate, textDuration } from "./script.js";
import { advanceCutSceneQueue, advanceWalk, bitmapWalkRegion, enteredTriggers, findWalkPath, interfacePoint, interpolatedScale, parseScalingStops, retainedRoomEntities, roomEntryItems, verbSentence } from "./interaction.js";

const inside = (x, y, [bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh;
const title = (value) => value[0].toUpperCase() + value.slice(1);


/** Validate an atomic two-object transaction using package protocol declarations. */
export function prepareItemUse(commands, world, protocol) {
  for (const field of ["walk_command", "take_command", "player_actor", "use_animation"]) if (!protocol?.[field]) throw new Error(`protocol.${field} is required`);
  const inventory = new Set(world.inventory);
  const visible = new Map(Object.entries(world.entities).map(([id, entity]) => [id, entity.visible !== "false"]));
  const prepared = [];
  for (const command of commands) {
    if (command.op === protocol.walk_command) {
      if (!world.entities[command.actor]) return null;
      if (command.point) prepared.push(command);
      else if (inventory.has(command.target)) continue;
      else if (visible.get(command.target)) prepared.push(command);
      else return null;
    } else if (command.op === protocol.take_command) {
      if (inventory.has(command.target)) continue;
      if (!visible.get(command.target)) return null;
      inventory.add(command.target); visible.set(command.target, false); prepared.push(command);
    } else if (command.op === "remove") {
      if (!inventory.has(command.target)) return null;
      inventory.delete(command.target); prepared.push(command);
    } else if (command.op === "replace") {
      if (!inventory.has(command.target) || inventory.has(command.replacement) || !world.items?.[command.replacement]) return null;
      inventory.delete(command.target); inventory.add(command.replacement); prepared.push(command);
    } else if (["show", "hide"].includes(command.op)) {
      if (!visible.has(command.target)) return null; visible.set(command.target, command.op === "show"); prepared.push(command);
    } else if (command.op === "set") {
      const [id] = command.target.split("."); if (id !== "game" && !visible.has(id)) return null; prepared.push(command);
    } else if (command.op === "enter") {
      if (!world.rooms[command.room]?.[`spawn.${command.spawn}`]) return null; prepared.push(command);
    } else prepared.push(command);
  }
  const lastWalk = prepared.findLastIndex(({ op }) => op === protocol.walk_command);
  prepared.splice(lastWalk + 1, 0, { op: "animate", actor: protocol.player_actor, animation: protocol.use_animation });
  return prepared;
}

/**
 * Deterministic package VM. It receives semantic actions only, owns every
 * authoritative transition, and publishes detached, immutable scene values.
 */
export class DeterministicVM {
  protocolValue(name) {
    const value = this.game.protocol?.[name];
    if (!value) throw new Error(`protocol.${name} is required`);
    return value;
  }
  get vmProtocol() { return this.game.protocol; }
  phrase(name, values = {}) {
    const template = this.ui.accessibility?.[name];
    if (!template) throw new Error(`accessibility.${name} is required`);
    return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value ?? ""), template);
  }
  action(event) {
    if (!event || typeof event.type !== "string") throw new TypeError("VM action events require a type");
    if (event.type === "pointer") return this.pointer(event);
    throw new Error(`Unknown VM action ${event.type}`);
  }
  sceneSnapshot() {
    return deepFreeze(structuredClone({ room: this.room, entities: this.entities, inventory: this.inventory,
      inventoryEntities: this.inventoryEntities, queue: this.queue, message: this.message,
      messageKind: this.messageKind, actionSentence: this.actionSentence, activeVerb: this.activeVerb,
      firstObject: this.firstObject, tick: this.tick, shakeTicks: this.shakeTicks }));
  }
  fallbackCommands(verb, args) {
    const target = args.at(-1), localEvent = `entity.fallback_${verb}`;
    const candidates = [
      this.handlers.find((handler) => handler.event === localEvent && handler.roomId === this.room && args.includes(handler.localTarget)),
      this.handlers.find((handler) => handler.event === `fallback.${verb}` && handler.itemId && args.includes(handler.localTarget)),
      this.handlers.find((handler) => handler.event === `fallback.${verb}` && handler.roomId === this.room && !handler.localTarget),
      this.handlers.find((handler) => handler.event === `fallback.${verb}` && !handler.roomId && !handler.itemId && !handler.localTarget)
    ];
    const handler = candidates.find(Boolean);
    if (handler) return instantiate(handler, args, this.scriptState());
    const spec = this.ui[`fallback.${verb}`] || this.ui.fallback || {};
    const template = spec.text || this.ui.fallback?.text;
    if (!template) throw new Error(`fallback.${verb}.text is required`);
    const labels = args.map((id) => this.label(id));
    const value = template.replaceAll("{verb}", this.ui[`verb.${verb}`]?.label || title(verb))
      .replaceAll("{target}", labels.at(-1)).replaceAll("{first}", labels[0]).replaceAll("{second}", labels[1] ?? "");
    return [{ op: "narrate", value }];
  }
  enqueueFallback(verb, args) { this.queue.push(...this.fallbackCommands(verb, args)); }
  enter(id, spawn) {
    const room = this.rooms[id]; if (!room) throw new Error(`Unknown room ${id}`);
    if (this.room && this.room !== id) this.backgroundTasks.cancelRoom(this.room);
    this.room = id;
    this.interactive = room.room.interactive !== "false";
    this.interfaceVisible = room.room.interface_visible !== "false" && room.room.fullscreen !== "true";
    this.playerScaling = parseScalingStops(room.room.player_scaling || "0,1; 1,1", `${id}.room.player_scaling`);
    this.playerWalkSpeedScaling = parseScalingStops(room.room.player_walk_speed_scaling || "0,1; 1,1", `${id}.room.player_walk_speed_scaling`);
    const mask = room.room.walk_mask;
    this.walkable = mask ? bitmapWalkRegion(this.bitmaps[mask], this.width, this.height) : () => true;
    this.entities = retainedRoomEntities(this.roomEntities, id, () => {
      const entities = Object.create(null);
      for (const [section, values] of Object.entries(room)) if (section.startsWith("entity.")) entities[section.slice(7)] = { id: section.slice(7), ...values, position: tuple(values.position, 2, `${section}.position`) };
      return entities;
    });
    if (this.roomState[id].visited !== true) {
      for (const item of roomEntryItems(room)) {
        if (!this.inventory.includes(item.id)) {
          this.inventory.push(item.id); this.inventoryEntities[item.id] = { ...item, visible: "false", position: [0, 0] };
        }
      }
      this.roomState[id].visited = true;
    }
    const point = tuple(room[`spawn.${spawn}`].position, 2, "spawn"), actorId = this.protocolValue("player_actor"), player = this.animations.player;
    if (!player?.graphic || !player.size) throw new Error("player graphic and size declarations are required");
    this.entities[actorId] = { id: actorId, position: point, graphic: player.graphic, size: player.size, origin: player.origin, label: player.label || actorId, visible: room.room.player_visible === "false" ? "false" : "true", facing: "down", moving: false, action: null, actionTicks: 0 };
    this.triggers = Object.fromEntries(Object.entries(room).filter(([section]) => section.startsWith("trigger.")).map(([section, values]) => [section.slice(8), tuple(values.rect, 4, `${section}.rect`)]));
    // A spawn may deliberately overlap a destination trigger. Treat it as
    // occupied until the player leaves, rather than immediately bouncing back.
    this.occupiedTriggers = enteredTriggers(point, this.triggers).occupied;
    this.dispatch("room.enter", [id]);
  }
  pointer({ button = 0, point, fast = false }) {
    if (!this.interactive && button === 0) { this.advanceCutScene(); return; }
    if (!this.interactive) return;
    if (fast && this.queue.length) { this.accelerateCommands(); return; }
    const [x, y] = point;
    {
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
    const target = this.targetAt(x, y, button !== 2);
    if (interfacePoint(x, y, this.ui, this.width, this.height) && !target) return;
    if (button === 2) {
      if (target) {
        this.clearSelection();
        const verb = this.suggestedVerb(target);
        if (verb === this.protocolValue("use_verb")) { this.activeVerb = verb; this.firstObject = target; this.hoverTarget = null; }
        else this.perform(verb, target);
      }
      return;
    }
    if (!this.activeVerb && this.inventory.includes(target)) return;
    if (!this.activeVerb) {
      this.interruptCommands(); this.actionSentence = this.phrase("walk_to", { target: target ? this.label(target) : "" }).trim();
      if (!target) this.queue = [{ op: "walk", actor: this.protocolValue("player_actor"), point: [Math.round(x), Math.round(y)], manual: true, fast }];
      else if (!this.dispatch("entity.walk", [target])) this.queue = [{ op: "walk", actor: this.protocolValue("player_actor"), point: [Math.round(x), Math.round(y)], manual: true }];
      if (fast) this.accelerateCommands();
      return;
    }
    if (this.activeVerb === this.protocolValue("use_verb")) {
      if (!this.firstObject && target) { this.firstObject = target; this.hoverTarget = null; return; }
      else if (target) {
        this.interruptCommands(); this.actionSentence = this.verbSentence(this.protocolValue("use_verb"), this.firstObject, target);
        const commands = this.commands("entity.use_item", [this.firstObject, target]);
        const prepared = commands && prepareItemUse(commands, this, this.vmProtocol);
        if (prepared) this.queue.push(...prepared);
        else this.enqueueFallback("use_item", [this.firstObject, target]);
      }
    } else this.perform(this.activeVerb, target);
    this.clearSelection();
  }
  perform(verb, target) { if (!target) return; this.interruptCommands(); this.actionSentence = this.verbSentence(verb, target); const commands = this.commands(`entity.${verb}`, [target]); if (commands) { if (verb === this.protocolValue("use_verb")) this.queue.push({ op: "animate", actor: this.protocolValue("player_actor"), animation: this.protocolValue("use_animation") }); this.queue.push(...commands); } else this.enqueueFallback(verb, [target]); }
  step() {
    this.tick++;
    this.backgroundTasks.step();
    if (this.shakeTicks > 0) this.shakeTicks--;
    if (this.message) { if (--this.messageTicks <= 0) this.dismissMessage(); return; }
    const player = this.entities[this.game.protocol.player_actor];
    if (player?.actionTicks > 0) { if (--player.actionTicks === 0) player.action = null; return; }
    const command = this.queue[0]; if (!command) { this.actionSentence = ""; return; }
    if (command.op === "walk") {
      const actor = this.entities[command.actor], target = command.point || this.entities[command.target]?.position;
      if (!actor || !target) return void this.queue.shift();
      const isPlayer = actor.id === this.game.protocol.player_actor;
      if (isPlayer && !command.route) command.route = findWalkPath(actor.position, target, this.walkable, this.width, this.height);
      const route = isPlayer ? command.route : [target];
      let budget = this.walkSpeed * (isPlayer ? interpolatedScale(actor.position[1], this.playerWalkSpeedScaling) : 1) * (command.fast ? this.fastWalkMultiplier : 1);
      while (route.length && budget > 0) {
        const waypoint = route[0], dx = waypoint[0] - actor.position[0], dy = waypoint[1] - actor.position[1];
        actor.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
        const distance = Math.hypot(dx, dy), result = advanceWalk(actor.position, waypoint, Math.min(budget, distance), 1, isPlayer ? this.walkable : () => true, (point) => { if (isPlayer) this.updateTriggers(point); });
        actor.position = result.point; budget -= Math.min(budget, distance);
        if (result.reached) route.shift(); else { actor.moving = !result.blocked; if (result.blocked) this.actionSentence = ""; break; }
      }
      actor.moving = route.length > 0;
      if (!route.length || !actor.moving) { actor.moving = false; this.queue.shift(); }
      return;
    }
    this.queue.shift();
    return this.execute(command);
  }
  execute(command) {
    if (command.op === "enter") this.enter(command.room, command.spawn);
    else if (command.op === "say" || command.op === "narrate") { if (command.skipPresentation) return; this.message = command.value; this.messageKind = command.op; this.messageTicks = command.fast ? 1 : textDuration(command.value, this.game.runtime); }
    else if (command.op === "animate") { const actor = this.entities[command.actor]; if (actor) { actor.moving = false; actor.action = command.animation; actor.actionTicks = command.skipPresentation ? 0 : (command.fast ? 1 : this.animationDuration(command.animation, actor.facing)); } }
    else if (command.op === "take") { const entity = this.entities[command.target]; if (entity && !this.inventory.includes(command.target)) { if (!command.animated) { this.queue.unshift({ ...command, animated: true }); this.queue.unshift({ op: "animate", actor: this.protocolValue("player_actor"), animation: this.protocolValue("pickup_animation") }); return; } entity.visible = "false"; this.inventoryEntities[command.target] = { ...this.items[command.target], ...entity }; this.inventory.push(command.target); this.scrollInventoryToEnd(); } }
    else if (command.op === "remove") { const index = this.inventory.indexOf(command.target); if (index >= 0) { this.inventory.splice(index, 1); delete this.inventoryEntities[command.target]; this.inventoryLayout(); } }
    else if (command.op === "replace") { const index = this.inventory.indexOf(command.target); if (index >= 0 && this.items[command.replacement] && !this.inventory.includes(command.replacement)) { this.inventory[index] = command.replacement; this.inventoryEntities[command.replacement] = { ...this.inventoryEntities[command.target], ...this.items[command.replacement] }; delete this.inventoryEntities[command.target]; } }
    else if (command.op === "hide" || command.op === "show") this.entities[command.target].visible = command.op === "show" ? "true" : "false";
    else if (command.op === "set") { const [id, field] = command.target.split("."); if (id === "game") this.globals[field] = command.value; else if (this.roomState[id]) this.roomState[id][field] = command.value; else this.entities[id][field] = String(command.value); }
    else if (command.op === "wait") { if (!command.skipPresentation) this.queue.unshift(...Array(command.fast ? 1 : command.ticks).fill({ op: "pause", skippable: command.skippable })); }
    else if (command.op === "shake") { if (!command.skipPresentation) this.shakeTicks = command.fast ? 1 : command.ticks; }
    else if (command.op === "spawn") this.backgroundTasks.start(command.definition, command.args, command.ownerRoom);
    else if (command.op === "pause") return;
    else if (command.op === "face") this.entities[command.actor].facing = command.direction;
  }
  performBackground(command) {
    if (command.op === "set") { const [id, field] = command.target.split("."); if (id === "game") this.globals[field] = command.value; else if (this.roomState[id]) this.roomState[id][field] = command.value; else if (this.entities[id]) this.entities[id][field] = String(command.value); }
    else if ((command.op === "show" || command.op === "hide") && this.entities[command.target]) this.entities[command.target].visible = command.op === "show" ? "true" : "false";
    else if (command.op === "face" && this.entities[command.actor]) this.entities[command.actor].facing = command.direction;
    else if (command.op === "spawn") this.backgroundTasks.start(command.definition, command.args, command.ownerRoom);
    else throw new Error(`script: ${command.op} is not supported in a background task`);
  }
  advanceCutScene() {
    if (this.message) { this.dismissMessage(); return; }
    const player = this.entities[this.game.protocol.player_actor];
    if (player?.actionTicks > 0) { player.actionTicks = 0; player.action = null; return; }
    if (this.shakeTicks > 0) { this.shakeTicks = 0; return; }
    advanceCutSceneQueue(this.queue);
  }
  updateTriggers(point) { const state = enteredTriggers(point, this.triggers, this.occupiedTriggers); this.occupiedTriggers = state.occupied; for (const id of state.entered) if (!this.queue.some(({ op }) => op === "enter")) this.dispatch("trigger.enter", [id]); }
}
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
