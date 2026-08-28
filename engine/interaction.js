/** Build a classic adventure-game sentence without moving its preposition. */
export function verbSentence(ui, label, verb, first, second = null) {
  const spec = ui[`verb.${verb}`] || {};
  const words = second
    ? [title(verb), label(first), spec.object_preposition, label(second)]
    : [title(verb), spec.preposition, label(first)];
  return words.filter(Boolean).join(" ");
}

/**
 * Validate an item-use transaction against a snapshot of the world and remove
 * acquisition commands which have already happened.  Returning null rejects
 * the complete transaction, so an invalid tail can never leave a half-finished
 * walk/take sequence running.
 */
export function prepareItemUse(commands, world) {
  const inventory = new Set(world.inventory);
  const visible = new Map(Object.entries(world.entities).map(([id, entity]) => [id, entity.visible !== "false"]));
  const prepared = [];

  for (const command of commands) {
    if (command.op === "walk") {
      if (!world.entities[command.actor]) return null;
      if (command.point) prepared.push(command);
      else if (inventory.has(command.target)) continue;
      else if (visible.get(command.target)) prepared.push(command);
      else return null;
    } else if (command.op === "take") {
      if (inventory.has(command.target)) continue;
      if (!visible.get(command.target)) return null;
      inventory.add(command.target);
      visible.set(command.target, false);
      prepared.push(command);
    } else if (["show", "hide"].includes(command.op)) {
      if (!visible.has(command.target)) return null;
      visible.set(command.target, command.op === "show");
      prepared.push(command);
    } else if (command.op === "set") {
      const [id] = command.target.split(".");
      if (id !== "game" && !visible.has(id)) return null;
      prepared.push(command);
    } else if (command.op === "enter") {
      if (!world.rooms[command.room]?.[`spawn.${command.spawn}`]) return null;
      prepared.push(command);
    } else prepared.push(command);
  }

  const lastWalk = prepared.findLastIndex(({ op }) => op === "walk");
  prepared.splice(lastWalk + 1, 0, { op: "animate", actor: "player", animation: "use" });
  return prepared;
}

/** Return trigger ids which have just been entered, while tracking occupancy. */
export function enteredTriggers(point, triggers, occupied = new Set()) {
  const next = new Set();
  const entered = [];
  for (const [id, rect] of Object.entries(triggers)) {
    if (pointInside(point, rect)) {
      next.add(id);
      if (!occupied.has(id)) entered.push(id);
    }
  }
  return { occupied: next, entered };
}

/** Create a room's entities once, then retain that mutable state across visits. */
export function retainedRoomEntities(states, room, create) {
  return states[room] || (states[room] = create());
}

const pointInside = ([x, y], [bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh;

const title = (value) => value[0].toUpperCase() + value.slice(1);
