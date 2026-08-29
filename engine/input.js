import { list } from "./ini.js";

const POINTER_BUTTONS = { primary: 0, middle: 1, secondary: 2 };

/** Parse [action.*] INI sections into physical-input lookup tables. */
export function parseActionBindings(ini) {
  const bindings = { keyboard: new Map(), pointer: new Map(), touch: new Map(), actions: [] };
  for (const [section, values] of Object.entries(ini)) {
    if (!section.startsWith("action.")) continue;
    const action = section.slice(7);
    if (!action) throw new Error("input action name cannot be empty");
    bindings.actions.push(action);
    for (const code of values.keyboard_code ? list(values.keyboard_code) : []) add(bindings.keyboard, code, action, section);
    for (const name of values.pointer_button ? list(values.pointer_button) : []) {
      if (!(name in POINTER_BUTTONS)) throw new Error(`${section}: unknown pointer button ${name}`);
      add(bindings.pointer, POINTER_BUTTONS[name], action, section);
    }
    for (const gesture of values.touch ? list(values.touch) : []) {
      if (!['tap', 'long_press'].includes(gesture)) throw new Error(`${section}: unknown touch gesture ${gesture}`);
      add(bindings.touch, gesture, action, section);
    }
  }
  return bindings;
}

function add(map, physical, action, section) {
  if (map.has(physical)) throw new Error(`${section}: ${physical} is already bound to ${map.get(physical)}`);
  map.set(physical, action);
}

/** Keep focus stable by id, falling back to the nearest surviving position. */
export function reconcileTargetFocus(targets, focusedId, previousIndex = 0) {
  if (!targets.length) return { id: null, index: -1 };
  const retained = targets.findIndex(({ id }) => id === focusedId);
  const index = retained >= 0 ? retained : Math.min(Math.max(previousIndex, 0), targets.length - 1);
  return { id: targets[index].id, index };
}
