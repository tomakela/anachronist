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

/**
 * Parse a room's semicolon-separated `y, scale` perspective stops. At least two
 * stops are required so that a room cannot silently declare a useless curve.
 */
export function parseScalingStops(value, label = "player_scaling") {
  if (!value) return null;
  const stops = value.split(";").map((entry) => {
    const parts = entry.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 2 || !parts.every(Number.isFinite) || parts[1] <= 0) throw new Error(`${label}: expected y, positive-scale pairs`);
    return parts;
  }).sort((a, b) => a[0] - b[0]);
  if (stops.length < 2) throw new Error(`${label}: requires at least two stops`);
  for (let i = 1; i < stops.length; i++) if (stops[i][0] === stops[i - 1][0]) throw new Error(`${label}: y coordinates must be unique`);
  return stops;
}

/** Linearly interpolate a scale, clamping positions beyond the end stops. */
export function interpolatedScale(y, stops) {
  if (!stops || y <= stops[0][0]) return stops?.[0][1] ?? 1;
  for (let i = 1; i < stops.length; i++) {
    const [endY, endScale] = stops[i], [startY, startScale] = stops[i - 1];
    if (y <= endY) return startScale + (endScale - startScale) * (y - startY) / (endY - startY);
  }
  return stops.at(-1)[1];
}

const pointInside = ([x, y], [bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh;

const title = (value) => value[0].toUpperCase() + value.slice(1);
