const TOKEN = /(?:([ \t\r]+)|(\/\/[^\n]*)|(\n)|("(?:\\.|[^"\\])*")|(-?\d+)|([A-Za-z_][\w.]*)|(==|!=|<=|>=|&&|\|\||[{}(),=!<>+\-*\/])|(;))/gy;

const scriptPosition = (source, offset) => {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1, offset };
};
const scriptRange = (source, start, end) => ({ start: scriptPosition(source, start), end: scriptPosition(source, end) });

export class ScriptDiagnosticError extends Error {
  constructor(diagnostic) { super(`${diagnostic.path}:${diagnostic.line}: ${diagnostic.message}`); this.name = "ScriptDiagnosticError"; this.diagnostic = diagnostic; }
}

function lex(source, path = "<script>") {
  const tokens = [];
  for (let offset = 0; offset < source.length;) {
    TOKEN.lastIndex = offset;
    const match = TOKEN.exec(source);
    if (!match) throw new ScriptDiagnosticError(makeScriptDiagnostic(source, path, offset, offset + 1, "script-invalid-token", "invalid token"));
    const start = offset;
    offset = TOKEN.lastIndex;
    if (match[1] || match[2]) continue;
    if (match[8]) throw new ScriptDiagnosticError(makeScriptDiagnostic(source, path, start, offset, "script-semicolon", "semicolons are invalid"));
    const token = match[3] ? { type: "newline", value: "\n" } :
      match[4] ? { type: "string", value: JSON.parse(match[4]) } :
      match[5] ? { type: "number", value: Number(match[5]) } :
      { type: "token", value: match[6] || match[7] };
    tokens.push({ ...token, raw: match[0], range: scriptRange(source, start, offset) });
  }
  return tokens;
}

const makeScriptDiagnostic = (source, path, start, end, code, message, severity = "error") => {
  const range = scriptRange(source, start, end), line = range.start.line, column = range.start.column;
  return { path, filePath: path, line, column, range, severity, code, message };
};

export const tokenizeScript = (source, path = "<script>") => lex(source, path);

function compileRuntime(source, compileContext = {}) {
  const path = compileContext.path || compileContext.url || "<script>";
  const t = lex(source, path); let p = 0;
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
    if (op === "walk") {
      const actor = take().value; take("to"); const destination = atom();
      node = peek(",") ? (take(), { op, actor, point: [destination, atom()] }) : { op, actor, target: destination.value };
    }
    else if (op === "say" || op === "narrate") node = { op, value: expression() };
    else if (["take", "show", "hide", "enable", "disable"].includes(op)) node = { op, target: take().value };
    else if (op === "remove") { node = { op, target: take().value }; take("from"); take("inventory"); }
    else if (op === "replace") { node = { op, target: take().value }; take("with"); node.replacement = take().value; take("in"); take("inventory"); }
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
    handlers.push({ event, declaredEvent, args, body: block(), skippable, tasks, ...(compileContext.roomId ? { roomId: compileContext.roomId } : {}), ...(compileContext.itemId ? { itemId: compileContext.itemId } : {}), ...(inventoryOnly ? { inventoryOnly: true } : {}), ...(localTarget ? { localTarget } : {}) });
    newlines();
  }
  for (const task of Object.values(tasks)) task.tasks = tasks;
  return handlers;
}

/** Editor-facing compilation result. It never throws syntax errors. */
export function compileScript(source, compileContext = {}) {
  const path = compileContext.path || compileContext.url || "<script>";
  let tokens;
  try {
    tokens = lex(source, path);
    const handlers = compileRuntime(source, compileContext);
    const declarations = declarationSyntax(tokens);
    const syntax = {
      type: "Script", path, source, tokens, range: scriptRange(source, 0, source.length),
      handlers: handlers.map((handler, index) => ({
        type: "HandlerDeclaration", event: handler.event, declaredEvent: handler.declaredEvent || handler.event,
        target: handler.localTarget, arguments: handler.args, commands: handler.body,
        range: declarations.handlers[index]?.range, eventRange: declarations.handlers[index]?.nameRange,
        argumentRanges: declarations.handlers[index]?.argumentRanges || [],
        commandRanges: declarations.handlers[index]?.commandRanges || [],
        stateReferences: collectStateReferences(handler.body)
      })),
      tasks: declarations.tasks
    };
    return { handlers, tokens, syntax, diagnostics: [] };
  } catch (error) {
    if (error instanceof ScriptDiagnosticError) return { handlers: [], tokens: tokens || [], syntax: null, diagnostics: [error.diagnostic] };
    const token = tokens?.find((candidate) => candidate.range.start.offset >= source.length) || tokens?.at(-1);
    const start = token?.range.start.offset ?? 0, end = token?.range.end.offset ?? start;
    const message = String(error.message).replace(/^script:\s*/, "");
    return { handlers: [], tokens: tokens || [], syntax: null,
      diagnostics: [makeScriptDiagnostic(source, path, start, end, "script-syntax-error", message)] };
  }
}

const COMMAND_WORDS = new Set(["sequence", "loop", "if", "walk", "say", "narrate", "take", "show", "hide", "enable", "disable", "remove", "replace", "enter", "set", "wait", "await", "shake", "spawn", "face"]);
function declarationSyntax(tokens) {
  const handlers = [], tasks = [];
  for (let i = 0, depth = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === "{") depth++;
    if (token.value === "}") depth--;
    if (depth !== 0 || !["on", "task"].includes(token.value)) continue;
    const kind = token.value, name = tokens[i + 1];
    let open = i + 2; while (open < tokens.length && tokens[open].value !== "{") open++;
    let close = open, nested = 0;
    for (; close < tokens.length; close++) { if (tokens[close].value === "{") nested++; if (tokens[close].value === "}" && --nested === 0) break; }
    const argumentRanges = [];
    for (let j = i + 2; j < open; j++) if (tokens[j].type === "token" && !["(", ")", ",", "skippable"].includes(tokens[j].value)) argumentRanges.push(tokens[j].range);
    const commandRanges = [];
    for (let j = open + 1; j < close; j++) if (COMMAND_WORDS.has(tokens[j].value)) commandRanges.push({ command: tokens[j].value, range: tokens[j].range });
    const node = { type: kind === "on" ? "HandlerDeclaration" : "TaskDeclaration", name: name?.value,
      range: { start: token.range.start, end: (tokens[close] || tokens.at(-1) || token).range.end }, nameRange: name?.range, argumentRanges, commandRanges };
    (kind === "on" ? handlers : tasks).push(node);
    i = close;
  }
  return { handlers, tasks };
}

const collectStateReferences = (body, found = []) => {
  const expression = (node) => { if (!node) return; if (node.kind === "name" && node.value.includes(".")) found.push(node.value); expression(node.left); expression(node.right); };
  for (const command of body || []) {
    if (typeof command.target === "string" && command.target.includes(".")) found.push(command.target);
    expression(command.test); expression(command.value); for (const arg of command.args || []) expression(arg);
    collectStateReferences(command.body, found); collectStateReferences(command.yes, found); collectStateReferences(command.no, found);
  }
  return found;
};

/** Runtime-compatible strict compiler. */
export function compile(source, compileContext = {}) {
  const result = compileScript(source, compileContext);
  if (result.diagnostics.length) throw new ScriptDiagnosticError(result.diagnostics[0]);
  return result.handlers;
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
    if (node.point) command.point = node.point.map((coordinate) => evaluate(coordinate, scope));
    if (node.op === "spawn") {
      const task = handler.tasks?.[node.task]; if (!task) throw new Error(`script: unknown task ${node.task}`);
      command.definition = task; command.args = node.args.map((arg) => evaluate(arg, scope)); command.ownerRoom = handler.roomId;
    }
    for (const key of ["actor", "target", "replacement", "room", "spawn"]) if (command[key] in context) command[key] = context[command[key]];
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
