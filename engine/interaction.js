import { nearestNeighbor } from "./bitmaps.js";

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

/** Return the row containing the newest inventory item. */
export function inventoryLastRow(itemCount, columns) {
  return Math.max(0, Math.ceil(itemCount / columns) - 1);
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

/** Advance a walk in base-speed samples so fast movement cannot jump barriers or triggers. */
export function advanceWalk(position, target, speed, multiplier, walkable, visit = () => {}) {
  let point = [...position], travelled = 0;
  const budget = Math.min(Math.hypot(target[0] - point[0], target[1] - point[1]), speed * multiplier);
  while (travelled < budget) {
    const remaining = Math.hypot(target[0] - point[0], target[1] - point[1]);
    const amount = Math.min(speed, budget - travelled, remaining);
    const next = remaining <= amount ? [...target] : [point[0] + (target[0] - point[0]) / remaining * amount, point[1] + (target[1] - point[1]) / remaining * amount];
    if (!walkable(next)) return { point, reached: false, blocked: true };
    point = next; travelled += amount; visit(point);
    if (remaining <= amount) break;
  }
  return { point, reached: point[0] === target[0] && point[1] === target[1], blocked: false };
}

/** Mark only the current explicitly skippable scene for safe acceleration. */
export function accelerateCommandQueue(queue) {
  const skipping = queue[0]?.skippable === true;
  for (const command of queue) {
    if (skipping && !command.skippable) break;
    command.fast = true;
    command.skipPresentation = skipping;
  }
  return skipping;
}

/** Advance only the current presentation phase of a non-interactive cut scene. */
export function advanceCutSceneQueue(queue) {
  let removedPause = false;
  while (queue[0]?.op === "pause") { queue.shift(); removedPause = true; }
  if (removedPause) return true;
  const command = queue[0];
  if (!command || !["wait", "say", "narrate", "animate", "shake"].includes(command.op)) return false;
  command.skipPresentation = true;
  return true;
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

/**
 * Sort scenery and actors back-to-front using explicit, stable z layers.
 * An entity with `z_clip` swaps sides of the player at that player-y: above
 * the line the entity is painted first; below it the player is painted first.
 */
export function entityRenderOrder(entities) {
  const player = Object.values(entities).find(({ id }) => id === "player");
  const playerZ = player?.z === undefined ? 100 : Number(player.z);
  return Object.values(entities).sort((a, b) => {
    const z = (entity) => {
      if (entity.id !== "player" && entity.z_clip !== undefined && player) {
        return playerZ + (player.position[1] < Number(entity.z_clip) ? -0.5 : 0.5);
      }
      return entity.z === undefined ? (entity.id === "player" ? 100 : 0) : Number(entity.z);
    };
    return z(a) - z(b) || a.id.localeCompare(b.id);
  });
}

/** Whether a visible entity participates in pointing and verb interactions. */
export function entityIsInteractive(entity) {
  return entity?.visible !== "false" && entity?.interactive !== "false";
}

/** Resolve and validate the verb suggested by an object's package metadata. */
export function objectSuggestedVerb(object, availableVerbs, fallback = "look") {
  const verb = object?.suggested_verb || fallback;
  if (!availableVerbs.includes(verb)) throw new Error(`suggested_verb: unknown verb ${verb}`);
  return verb;
}

/** Parse an absolute room-space rectangle or polygon declared by an entity. */
export function entityHotspot(entity) {
  if (entity.hotspot_rect) {
    const values = tupleNumbers(entity.hotspot_rect);
    if (values.length !== 4 || !values.every(Number.isFinite) || values[2] < 0 || values[3] < 0) throw new Error(`${entity.id}.hotspot_rect: expected x,y,width,height`);
    return { kind: "rect", points: values };
  }
  if (entity.hotspot_polygon) {
    const points = entity.hotspot_polygon.split(";").map((part) => tupleNumbers(part.trim()));
    if (points.length < 3 || points.some((point) => point.length !== 2 || !point.every(Number.isFinite))) throw new Error(`${entity.id}.hotspot_polygon: expected at least three x,y points`);
    return { kind: "polygon", points };
  }
  return null;
}

export function pointInHotspot(point, hotspot) {
  if (hotspot.kind === "rect") return pointInside(point, hotspot.points);
  let inside = false;
  for (let i = 0, j = hotspot.points.length - 1; i < hotspot.points.length; j = i++) {
    const [xi, yi] = hotspot.points[i], [xj, yj] = hotspot.points[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Pick the visually topmost hit; hotspot_priority can deliberately override z order. */
export function entityTargetAt(point, entities, hit) {
  return entityRenderOrder(entities).map((entity, order) => ({ entity, order }))
    .filter(({ entity }) => entity.id !== "player" && entityIsInteractive(entity) && hit(entity, point))
    .sort((a, b) => Number(a.entity.hotspot_priority || 0) - Number(b.entity.hotspot_priority || 0) || a.order - b.order)
    .at(-1)?.entity.id;
}

/** Map a room point through sprite scale/rotation and test cached source-frame alpha. */
export function spriteAlphaHit(point, bounds, source, pixels, rotation = 0) {
  const [x, y, w, h] = bounds, angle = -Number(rotation) * Math.PI / 180;
  let dx = point[0] - (x + w / 2), dy = point[1] - (y + h / 2);
  [dx, dy] = [dx * Math.cos(angle) - dy * Math.sin(angle), dx * Math.sin(angle) + dy * Math.cos(angle)];
  const [sx, sy, sw, sh] = source;
  const px = Math.floor(sx + (dx / w + .5) * sw), py = Math.floor(sy + (dy / h + .5) * sh);
  return px >= sx && py >= sy && px < sx + sw && py < sy + sh && pixels.data[(py * pixels.width + px) * 4 + 3] > 0;
}

/** Turn a black/transparent bitmap mask into a logical-room point predicate. */
export function bitmapWalkRegion(bitmap, logicalWidth, logicalHeight, canvasFactory = () => document.createElement("canvas")) {
  if (!bitmap) throw new Error("walk_mask references an unknown graphic");
  const canvas = canvasFactory(); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = nearestNeighbor(canvas.getContext("2d", { willReadFrequently: true })); context.drawImage(bitmap, 0, 0);
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
