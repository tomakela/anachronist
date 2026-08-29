/** Build a classic adventure-game sentence without moving its preposition. */
export function verbSentence(ui, label, verb, first, second = null) {
  const spec = ui[`verb.${verb}`] || {};
  const words = second
    ? [title(verb), label(first), spec.object_preposition, label(second)]
    : [title(verb), spec.preposition, label(first)];
  return words.filter(Boolean).join(" ");
}

/** Return a deterministic logical-pixel offset for an active screen shake. */
export function shakeOffset(ticksRemaining, amplitude) {
  if (ticksRemaining <= 0 || amplitude <= 0) return [0, 0];
  return [[-amplitude, 0], [amplitude, 0], [0, -amplitude], [0, amplitude]][ticksRemaining % 4];
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

/** Read inventory items granted by a room's package data. */
export function roomEntryItems(room) {
  return Object.entries(room).filter(([section]) => section.startsWith("inventory."))
    .map(([section, values]) => ({ id: section.slice(10), ...values }));
}

/** Calculate the visible inventory page and whether either arrow is enabled. */
export function inventoryPage(itemCount, row, columns) {
  const rows = Math.max(1, Math.ceil(itemCount / columns));
  const current = Math.max(0, Math.min(row, rows - 1));
  return { row: current, start: current * columns, end: Math.min(itemCount, (current + 1) * columns), up: current > 0, down: current < rows - 1 };
}

/** Move a virtual cursor by a touch delta, amplified by configured sensitivity. */
export function dragCursor(point, delta, sensitivity, width, height) {
  const amount = Number(sensitivity);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("dragging_sensitivity must be a positive number");
  return [
    Math.max(0, Math.min(width - 1, point[0] + delta[0] * amount)),
    Math.max(0, Math.min(height - 1, point[1] + delta[1] * amount))
  ];
}

/** True only when a touch has moved beyond the allowed long-touch jitter. */
export function touchMoved(start, point, tolerance) {
  const amount = Number(tolerance);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("long_touch_move_tolerance must be a non-negative number");
  return Math.hypot(point[0] - start[0], point[1] - start[1]) > amount;
}

/** True when a point belongs to the non-walkable interface at the screen foot. */
export function interfacePoint(x, y, ui, width, height) {
  const regions = [ui.sentence_region?.rect, ui.verb_panel?.region_rect, ui.inventory_panel?.rect]
    .filter(Boolean).map((rect) => tupleNumbers(rect));
  if (!ui.verb_panel?.region_rect) {
    const verbRects = Object.entries(ui).filter(([name]) => name.startsWith("verb.")).map(([, spec]) => tupleNumbers(spec.rect));
    regions.push(...verbRects);
  }
  if (!ui.inventory_panel?.rect && ui.inventory_panel?.origin) {
    const [originX, originY] = tupleNumbers(ui.inventory_panel.origin);
    regions.push([originX, originY, width - originX, height - originY]);
  }
  return regions.some((rect) => pointInside([x, y], rect));
}

const tupleNumbers = (value) => value.split(",").map((part) => Number(part.trim()));

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

/** Sort scenery and actors back-to-front. Explicit depth wins; y is the default. */
export function entityRenderOrder(entities) {
  return Object.values(entities).sort((a, b) => {
    const depth = (entity) => entity.depth === undefined ? entity.position[1] : Number(entity.depth);
    return depth(a) - depth(b) || a.id.localeCompare(b.id);
  });
}

/** Turn a black/transparent bitmap mask into a logical-room point predicate. */
export function bitmapWalkRegion(bitmap, logicalWidth, logicalHeight, canvasFactory = () => document.createElement("canvas")) {
  if (!bitmap) throw new Error("walk_mask references an unknown graphic");
  const canvas = canvasFactory(); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return ([x, y]) => {
    if (x < 0 || y < 0 || x >= logicalWidth || y >= logicalHeight) return false;
    const px = Math.min(canvas.width - 1, Math.floor(x * canvas.width / logicalWidth));
    const py = Math.min(canvas.height - 1, Math.floor(y * canvas.height / logicalHeight));
    const offset = (py * canvas.width + px) * 4;
    return pixels[offset + 3] > 0 && (pixels[offset] > 0 || pixels[offset + 1] > 0 || pixels[offset + 2] > 0);
  };
}

const pointInside = ([x, y], [bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh;

const title = (value) => value[0].toUpperCase() + value.slice(1);
