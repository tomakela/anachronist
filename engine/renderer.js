import { tuple } from "./ini.js";
import { nearestNeighbor } from "./bitmaps.js";
import { entityRenderOrder, interpolatedScale } from "./interaction.js";

/** An explicit null graphic keeps an entity's geometry without drawing a sprite. */
export const isNullGraphic = (graphic) => graphic == null || graphic === "null";

/** Runtime/editor shared sprite geometry. Position is the sprite origin in room space. */
export function entityBounds(entity, graphics, scalingStops = null) {
  const spec = graphics[`graphic.${entity.graphic}`] || {};
  const baseSize = tuple(entity.size || `${spec.width || 1},${spec.height || 1}`, 2, `${entity.id}.size`);
  const baseOrigin = entity.origin ? tuple(entity.origin, 2, `${entity.id}.origin`) : [baseSize[0] / 2, baseSize[1] / 2];
  const scale = interpolatedScale(entity.position[1], scalingStops);
  const size = baseSize.map(value => value * Number(entity.scale || 1) * scale);
  const origin = baseOrigin.map(value => value * Number(entity.scale || 1) * scale);
  return [entity.position[0] - origin[0], entity.position[1] - origin[1], ...size];
}

/** Draw one bitmap with the production nearest-neighbour, origin and rotation rules. */
export function drawEntityBitmap(context, entity, bitmap, bounds, source = null) {
  const [x, y, width, height] = bounds, angle = Number(entity.rotation || 0) * Math.PI / 180;
  const args = source ? [bitmap, ...source, -width / 2, -height / 2, width, height] : [bitmap, -width / 2, -height / 2, width, height];
  context.save(); context.translate(Math.round(x + width / 2), Math.round(y + height / 2));
  if (angle) context.rotate(angle);
  nearestNeighbor(context).drawImage(...args); context.restore();
}

/** Draw the unadorned room scene. Authoring overlays belong on a separate canvas. */
export function drawRoomScene(context, { width, height, room, entities, graphics, bitmaps, scalingStops = null, frameFor = () => null }) {
  const background = room?.room?.background_color || "#000";
  context.fillStyle = background; context.fillRect(0, 0, width, height);
  const backgroundImage = room?.room?.background_image || room?.room?.background_graphic;
  if (backgroundImage) {
    const bitmap = bitmaps[backgroundImage];
    if (!bitmap) throw new Error(`room.background_image references unknown graphic ${backgroundImage}`);
    nearestNeighbor(context).drawImage(bitmap, 0, 0, width, height);
  }
  for (const entity of entityRenderOrder(entities)) {
    if (entity.visible === "false") continue;
    const bounds = entityBounds(entity, graphics, entity.id === "player" ? scalingStops : null);
    if (isNullGraphic(entity.graphic)) continue;
    const bitmap = bitmaps[entity.graphic];
    if (bitmap) drawEntityBitmap(context, entity, bitmap, bounds, frameFor(entity));
    else { context.fillStyle = graphics[`graphic.${entity.graphic}`]?.missing_color || "#ff00ff"; context.fillRect(...bounds); }
  }
}
