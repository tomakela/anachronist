const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** JSON with recursively sorted object keys, so identical runtime states have identical saves. */
export function stableStringify(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

export function snapshotRuntime(runtime, identity) {
  const roomEntities = { ...runtime.roomEntities, [runtime.room]: runtime.entities };
  const entities = clone(roomEntities);
  const player = entities[runtime.room]?.player;
  if (player) { player.moving = false; player.action = null; player.actionTicks = 0; }
  return {
    package_id: identity.packageId,
    format_version: identity.formatVersion,
    state: {
      room: runtime.room,
      entities,
      globals: clone(runtime.globals),
      roomState: clone(runtime.roomState),
      inventory: clone(runtime.inventory),
      inventoryEntities: clone(runtime.inventoryEntities),
      inventoryRow: runtime.inventoryRow
    }
  };
}

export function validateSnapshot(value, identity, rooms, items = {}) {
  if (!isRecord(value)) throw new Error("Save data is not an object");
  if (value.package_id !== identity.packageId) throw new Error("Save belongs to a different game package");
  if (String(value.format_version) !== String(identity.formatVersion)) throw new Error("Save format is not compatible with this game");
  const state = value.state;
  if (!isRecord(state) || typeof state.room !== "string" || !rooms[state.room]) throw new Error("Save has an invalid room");
  for (const field of ["entities", "globals", "roomState", "inventoryEntities"]) if (!isRecord(state[field])) throw new Error(`Save has invalid ${field}`);
  if (!Array.isArray(state.inventory) || !state.inventory.every((id) => typeof id === "string" && items[id])) throw new Error("Save has invalid inventory");
  if (!isRecord(state.entities[state.room]) || !isRecord(state.entities[state.room].player)) throw new Error("Save has no player state");
  const position = state.entities[state.room].player.position;
  if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) throw new Error("Save has an invalid player position");
  if (!Number.isInteger(state.inventoryRow) || state.inventoryRow < 0) throw new Error("Save has an invalid inventory position");
  return clone(state);
}

/** The only browser-storage boundary used by the runtime. */
export class SaveStorage {
  constructor(storage, packageId) { this.storage = storage; this.key = `anachronist.save.${packageId}`; }
  exists() { return this.storage.getItem(this.key) !== null; }
  write(snapshot) { this.storage.setItem(this.key, stableStringify(snapshot)); }
  read() {
    const data = this.storage.getItem(this.key);
    if (data === null) throw new Error("No saved game was found");
    try { return JSON.parse(data); } catch { throw new Error("The saved game is corrupt"); }
  }
  remove() { this.storage.removeItem(this.key); }
}
