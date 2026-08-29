const TOKEN = /(?:([ \t\r]+)|(\/\/[^\n]*)|(\n)|("(?:\\.|[^"\\])*")|(-?\d+)|([A-Za-z_][\w.]*)|(==|!=|<=|>=|&&|\|\||[{}(),=!<>+\-*\/])|(;))/gy;

function lex(source) {
  const tokens = [];
  for (let offset = 0; offset < source.length;) {
    TOKEN.lastIndex = offset;
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`script:${source.slice(0, offset).split("\n").length}: invalid token`);
    offset = TOKEN.lastIndex;
    if (match[1] || match[2]) continue;
    if (match[8]) throw new Error(`script:${source.slice(0, offset).split("\n").length}: semicolons are invalid`);
    tokens.push(match[3] ? { type: "newline", value: "\n" } :
      match[4] ? { type: "string", value: JSON.parse(match[4]) } :
      match[5] ? { type: "number", value: Number(match[5]) } :
      { type: "token", value: match[6] || match[7] });
  }
  return tokens;
}

export function compile(source, compileContext = {}) {
  const t = lex(source); let p = 0;
  const peek = (value) => t[p]?.value === value;
  const take = (value) => { const token = t[p++]; if (!token || (value && token.value !== value)) throw new Error(`script: expected ${value || "token"}`); return token; };
  const newlines = () => { while (peek("\n")) take(); };
  const end = () => { if (peek("\n")) newlines(); else if (!peek("}")) throw new Error("script: expected newline or }"); };
  const block = () => { take("{"); newlines(); const out = []; while (!peek("}")) out.push(statement()); take("}"); return out; };
  const atom = () => {
    const token = take();
    if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true" };
    if (token.value === "null" || token.type === "number" || token.type === "string") return { kind: "literal", value: token.value === "null" ? null : token.value };
    return { kind: "name", value: token.value };
  };
  const expression = () => { let left = atom(); if (["==", "!=", "<", ">", "<=", ">="].includes(t[p]?.value)) left = { kind: "binary", op: take().value, left, right: atom() }; return left; };
  const statement = () => {
    const op = take().value;
    if (op === "sequence" || op === "loop") { const node = { op, body: block() }; end(); return node; }
    if (op === "if") {
      const parenthesized = peek("("); if (parenthesized) take();
      const test = expression(); if (parenthesized) take(")");
      const yes = block(); const afterYes = p; newlines();
      const no = peek("else") ? (take(), newlines(), block()) : (p = afterYes, []);
      end(); return { op, test, yes, no };
    }
    let node;
    if (op === "walk") { const actor = take().value; take("to"); node = { op, actor, target: take().value }; }
    else if (op === "say" || op === "narrate") node = { op, value: expression() };
    else if (["take", "show", "hide", "enable", "disable"].includes(op)) node = { op, target: take().value };
    else if (op === "enter") { take("room"); const room = take().value; take("at"); node = { op, room, spawn: take().value }; }
    else if (op === "set") { const target = take().value; take("="); node = { op, target, value: expression() }; }
    else if (op === "wait" || op === "await" || op === "shake") { const ticks = take().value; take("ticks"); node = { op: op === "await" ? "await" : op, ticks }; }
    else if (op === "spawn") {
      const task = take().value; take("("); const args = [];
      while (!peek(")")) { args.push(expression()); if (!peek(")")) take(","); }
      take(")"); node = { op, task, args };
    }
    else if (op === "face") node = { op, actor: take().value, direction: take().value };
    else throw new Error(`script: unsupported statement ${op}`);
    end(); return node;
  };
  newlines();
  if (peek("module")) throw new Error("script: module declarations are not supported");
  const handlers = [], tasks = Object.create(null);
  while (p < t.length) {
    if (peek("task")) {
      take(); const name = take().value; take("("); const args = [];
      while (!peek(")")) { args.push(take().value); if (!peek(")")) take(","); }
      take(")"); newlines();
      if (tasks[name]) throw new Error(`script: duplicate task ${name}`);
      tasks[name] = { name, args, body: block(), ...(compileContext.roomId ? { roomId: compileContext.roomId } : {}) };
      newlines(); continue;
    }
    take("on"); const declaredEvent = take().value; take("("); const args = [];
    while (!peek(")")) { args.push(take().value); if (!peek(")")) take(","); }
    take(")"); newlines();
    const skippable = peek("skippable") ? (take(), newlines(), true) : false;
    let event = declaredEvent, localTarget;
    let inventoryOnly = false;
    if (compileContext.itemId && declaredEvent.startsWith("fallback.")) { localTarget = compileContext.itemId; args.push("target"); inventoryOnly = true; }
    else if (compileContext.itemId && declaredEvent.startsWith("inventory.")) {
      const [namespace, item, action, extra] = declaredEvent.split(".");
      if (namespace !== "inventory" || item !== compileContext.itemId || !action || extra) throw new Error(`script: invalid inventory event ${declaredEvent}`);
      event = `entity.${action}`; localTarget = item; args.push("target"); inventoryOnly = true;
    }
    else if (compileContext.itemId) throw new Error(`script: inventory handler must reference inventory.${compileContext.itemId}`);
    else if (compileContext.roomId && declaredEvent === "enter") { event = "room.enter"; args.push("room"); }
    else if (compileContext.roomId && declaredEvent.startsWith("fallback.")) { /* package-style room fallback */ }
    else if (compileContext.roomId && declaredEvent.includes(".") && !["game", "room", "entity", "trigger"].includes(declaredEvent.split(".")[0])) {
      const [entity, action, extra] = declaredEvent.split(".");
      if (!action || extra) throw new Error(`script: invalid room event ${declaredEvent}`);
      if (compileContext.entities && !compileContext.entities.includes(entity)) throw new Error(`script: unknown local entity ${entity}`);
      event = `entity.${action}`; localTarget = entity; args.push("target");
    }
    handlers.push({ event, args, body: block(), skippable, tasks, ...(compileContext.roomId ? { roomId: compileContext.roomId } : {}), ...(compileContext.itemId ? { itemId: compileContext.itemId } : {}), ...(inventoryOnly ? { inventoryOnly: true } : {}), ...(localTarget ? { localTarget } : {}) });
    newlines();
  }
  for (const task of Object.values(tasks)) task.tasks = tasks;
  return handlers;
}

const evaluate = (expr, context) => expr.kind === "literal" ? expr.value : expr.kind === "name" ?
  (expr.value in context ? context[expr.value] : expr.value) : ({ "==": (a,b)=>a===b, "!=":(a,b)=>a!==b, "<":(a,b)=>a<b, ">":(a,b)=>a>b, "<=":(a,b)=>a<=b, ">=":(a,b)=>a>=b }[expr.op](evaluate(expr.left, context), evaluate(expr.right, context)));

export function instantiate(handler, supplied, state = Object.create(null)) {
  if (handler.roomId && handler.event === "room.enter" && supplied[0] !== handler.roomId) return [];
  if (handler.localTarget && supplied.at(-1) !== handler.localTarget) return [];
  const context = Object.fromEntries(handler.args.map((name, i) => [name, supplied[i]]));
  const resolve = (name) => {
    if (name in context) return context[name];
    let value = state;
    for (const part of name.split(".")) { if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return name; value = value[part]; }
    return value;
  };
  const scope = new Proxy(context, { get: (_, key) => resolve(key), has: () => true });
  const commands = [];
  const expand = (body) => body.forEach((node) => {
    if (node.op === "sequence") return expand(node.body);
    if (node.op === "loop") { const body = []; const previous = commands.splice(0); expand(node.body); body.push(...commands.splice(0)); commands.push(...previous, { op: "loop", body }); return; }
    if (node.op === "if") return expand(evaluate(node.test, scope) ? node.yes : node.no);
    const command = { ...node, value: node.value ? evaluate(node.value, scope) : undefined };
    if (node.op === "spawn") {
      const task = handler.tasks?.[node.task]; if (!task) throw new Error(`script: unknown task ${node.task}`);
      command.definition = task; command.args = node.args.map((arg) => evaluate(arg, scope)); command.ownerRoom = handler.roomId;
    }
    for (const key of ["actor", "target", "room", "spawn"]) if (command[key] in context) command[key] = context[command[key]];
    commands.push({ ...command, ...(handler.skippable ? { skippable: true } : {}) });
  });
  expand(handler.body); return commands;
}

export function textDuration(text, runtime) {
  if (!runtime.text_ticks_per_character) return Number(runtime.text_duration_ticks);
  const base = Number(runtime.text_base_ticks || 0), perCharacter = Number(runtime.text_ticks_per_character), minimum = Number(runtime.text_minimum_ticks || 1);
  for (const [name, value] of [["text_base_ticks", base], ["text_ticks_per_character", perCharacter], ["text_minimum_ticks", minimum]]) if (!Number.isInteger(value)) throw new Error(`${name}: expected integer`);
  return Math.max(minimum, base + String(text).length * perCharacter);
}

export class BackgroundTasks {
  constructor(execute) { this.execute = execute; this.tasks = []; }
  start(definition, supplied = [], ownerRoom = definition.roomId) {
    const handler = { args: definition.args, body: definition.body, tasks: definition.tasks };
    this.tasks.push({ queue: instantiate(handler, supplied), ownerRoom, waiting: 0 });
  }
  cancelRoom(room) { this.tasks = this.tasks.filter((task) => task.ownerRoom !== room); }
  step() {
    for (const task of [...this.tasks]) {
      if (task.waiting > 0) { task.waiting--; continue; }
      let command = task.queue.shift();
      while (command?.op === "loop") {
        task.queue.push(...command.body.map((item) => ({ ...item })), command);
        command = task.queue.shift();
      }
      if (!command) { this.tasks.splice(this.tasks.indexOf(task), 1); continue; }
      if (command.op === "await" || command.op === "wait") task.waiting = Math.max(0, Number(command.ticks));
      else if (command.op === "spawn") this.start(command.definition, command.args, command.ownerRoom ?? task.ownerRoom);
      else this.execute(command);
    }
  }
}
