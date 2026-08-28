const TOKEN = /\s*(?:(\/\/[^\n]*(?:\n|$))|("(?:\\.|[^"\\])*")|(-?\d+)|([A-Za-z_][\w.]*)|(==|!=|<=|>=|&&|\|\||[{}();,=!<>+\-*\/]))/gy;

function lex(source) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    TOKEN.lastIndex = offset;
    const match = TOKEN.exec(source);
    if (!match) {
      if (/^\s*$/.test(source.slice(offset))) break;
      throw new Error(`script:${source.slice(0, offset).split("\n").length}: invalid token`);
    }
    offset = TOKEN.lastIndex;
    if (!match[1]) tokens.push(match[2] ? { type: "string", value: JSON.parse(match[2]) } :
      match[3] ? { type: "number", value: Number(match[3]) } : { type: "token", value: match[4] || match[5] });
  }
  return tokens;
}

export function compile(source) {
  const t = lex(source); let p = 0;
  const peek = (value) => t[p]?.value === value;
  const take = (value) => { const token = t[p++]; if (!token || (value && token.value !== value)) throw new Error(`script: expected ${value || "token"}`); return token; };
  const block = () => { take("{"); const out = []; while (!peek("}")) out.push(statement()); take("}"); return out; };
  const atom = () => {
    const token = take();
    if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true" };
    if (token.value === "null" || token.type === "number" || token.type === "string") return { kind: "literal", value: token.value === "null" ? null : token.value };
    return { kind: "name", value: token.value };
  };
  const expression = () => { let left = atom(); if (["==", "!=", "<", ">", "<=", ">="].includes(t[p]?.value)) left = { kind: "binary", op: take().value, left, right: atom() }; return left; };
  const statement = () => {
    const op = take().value;
    if (op === "sequence") return { op, body: block() };
    if (op === "if") { take("("); const test = expression(); take(")"); const yes = block(); const no = peek("else") ? (take("else"), block()) : []; return { op, test, yes, no }; }
    if (op === "walk") { const actor = take().value; take("to"); const target = take().value; take(";"); return { op, actor, target }; }
    if (op === "say" || op === "narrate") { const value = expression(); take(";"); return { op, value }; }
    if (["take", "show", "hide", "enable", "disable"].includes(op)) { const target = take().value; take(";"); return { op, target }; }
    if (op === "enter") { take("room"); const room = take().value; take("at"); const spawn = take().value; take(";"); return { op, room, spawn }; }
    if (op === "set") { const target = take().value; take("="); const value = expression(); take(";"); return { op, target, value }; }
    if (op === "wait") { const ticks = take().value; take("ticks"); take(";"); return { op, ticks }; }
    if (op === "face") { const actor = take().value; const direction = take().value; take(";"); return { op, actor, direction }; }
    throw new Error(`script: unsupported statement ${op}`);
  };
  if (peek("module")) { take(); take(); take(";"); }
  const handlers = [];
  while (p < t.length) {
    take("on"); const event = take().value; take("("); const args = [];
    while (!peek(")")) { args.push(take().value); if (!peek(")")) take(","); }
    take(")"); handlers.push({ event, args, body: block() });
  }
  return handlers;
}

const evaluate = (expr, context) => expr.kind === "literal" ? expr.value : expr.kind === "name" ?
  (expr.value in context ? context[expr.value] : expr.value) : ({ "==": (a,b)=>a===b, "!=":(a,b)=>a!==b, "<":(a,b)=>a<b, ">":(a,b)=>a>b, "<=":(a,b)=>a<=b, ">=":(a,b)=>a>=b }[expr.op](evaluate(expr.left, context), evaluate(expr.right, context)));

// The entire handler is expanded before the first command is returned. This is
// the transaction boundary that prevents a partially entered command chain.
export function instantiate(handler, supplied, state = Object.create(null)) {
  const context = Object.fromEntries(handler.args.map((name, i) => [name, supplied[i]]));
  const resolve = (name) => {
    if (name in context) return context[name];
    let value = state;
    for (const part of name.split(".")) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return name;
      value = value[part];
    }
    return value;
  };
  const scope = new Proxy(context, { get: (_, key) => resolve(key), has: () => true });
  const commands = [];
  const expand = (body) => body.forEach((node) => {
    if (node.op === "sequence") return expand(node.body);
    if (node.op === "if") return expand(evaluate(node.test, scope) ? node.yes : node.no);
    const command = { ...node, value: node.value ? evaluate(node.value, scope) : undefined };
    for (const key of ["actor", "target", "room", "spawn"]) if (command[key] in context) command[key] = context[command[key]];
    commands.push(command);
  });
  expand(handler.body);
  return commands;
}

/** Return the configured display time for one item in a dialogue sequence. */
export function textDuration(text, runtime) {
  if (!runtime.text_ticks_per_character) return Number(runtime.text_duration_ticks);
  const base = Number(runtime.text_base_ticks || 0), perCharacter = Number(runtime.text_ticks_per_character), minimum = Number(runtime.text_minimum_ticks || 1);
  for (const [name, value] of [["text_base_ticks", base], ["text_ticks_per_character", perCharacter], ["text_minimum_ticks", minimum]]) if (!Number.isInteger(value)) throw new Error(`${name}: expected integer`);
  return Math.max(minimum, base + String(text).length * perCharacter);
}
