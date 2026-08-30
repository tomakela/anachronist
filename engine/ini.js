const position = (source, offset) => {
  const before = source.slice(0, offset), lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1, offset };
};

const range = (source, start, end) => ({ start: position(source, start), end: position(source, end) });

export class IniDiagnosticError extends Error {
  constructor(diagnostic) { super(`${diagnostic.path}:${diagnostic.range.start.line}: ${diagnostic.message}`); this.name = "IniDiagnosticError"; this.diagnostic = diagnostic; }
}

/**
 * Lossless, editor-facing INI parser. `nodes` is a concrete syntax tree: its
 * ranges point into the original source and comments/whitespace remain nodes.
 * The familiar parsed object is available as `value`.
 */
export function parseIniDocument(source, url = "<ini>") {
  const result = Object.create(null);
  Object.defineProperty(result, "$variables", { value: Object.create(null), enumerable: false });
  const nodes = [], diagnostics = [];
  let section = null;
  let offset = 0;
  source.split(/\n/).forEach((withCr) => {
    const raw = withCr.endsWith("\r") ? withCr.slice(0, -1) : withCr;
    const lineRange = range(source, offset, offset + raw.length);
    const line = raw.trim();
    if (!line) { nodes.push({ type: "blank", raw, range: lineRange }); offset += withCr.length + 1; return; }
    if (line.startsWith(";") || line.startsWith("#")) { nodes.push({ type: "comment", raw, value: line.slice(1), range: lineRange }); offset += withCr.length + 1; return; }
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      const start = offset + raw.indexOf("[");
      const node = { type: "section", name: section, raw, range: lineRange, nameRange: range(source, start + 1, start + 1 + section.length) };
      nodes.push(node);
      if (result[section]) diagnostics.push(diagnostic(url, node.nameRange, "ini-duplicate-section", `duplicate section ${section}`));
      else result[section] = Object.create(null);
      offset += withCr.length + 1; return;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(raw);
    if (!pair) { nodes.push({ type: "invalid", raw, range: lineRange }); diagnostics.push(diagnostic(url, lineRange, "ini-invalid-entry", "invalid INI entry")); offset += withCr.length + 1; return; }
    const key = pair[1].trim();
    const destination = section ? result[section] : result.$variables;
    const keyStart = offset + raw.indexOf(key), equals = raw.indexOf("=", keyStart - offset);
    const rawValue = pair[2].trim(), valueStart = offset + equals + 1 + raw.slice(equals + 1).indexOf(rawValue);
    const node = { type: "property", section, key, value: rawValue, raw, range: lineRange,
      keyRange: range(source, keyStart, keyStart + key.length), valueRange: range(source, valueStart, valueStart + rawValue.length) };
    nodes.push(node);
    if (key in destination) diagnostics.push(diagnostic(url, node.keyRange, "ini-duplicate-key", `duplicate key ${key}`));
    else if (section) destination[key] = rawValue;
    else {
      try { destination[key] = iniValue(rawValue); }
      catch { diagnostics.push(diagnostic(url, node.valueRange, "ini-invalid-quoted-value", "invalid quoted variable")); }
    }
    offset += withCr.length + 1;
  });
  return { type: "IniDocument", source, path: url, value: result, nodes, diagnostics, range: range(source, 0, source.length) };
}

const diagnostic = (path, range, code, message, severity = "error") => ({ path, filePath: path, range, line: range.start.line, column: range.start.column, severity, code, message });

/** Runtime-compatible strict wrapper. */
export function parseIni(source, url = "<ini>") {
  const document = parseIniDocument(source, url);
  if (document.diagnostics.length) throw new IniDiagnosticError(document.diagnostics[0]);
  Object.defineProperty(document.value, "$syntax", { value: document, enumerable: false });
  return document.value;
}

function iniValue(value) {
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

export const integer = (value, label) => {
  if (!/^-?\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
};

export const tuple = (value, count, label) => {
  const values = value.split(",").map((part) => integer(part.trim(), label));
  if (values.length !== count) throw new Error(`${label} requires ${count} values`);
  return values;
};

export const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
