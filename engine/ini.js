export function parseIni(source, url = "<ini>") {
  const result = Object.create(null);
  let section = null;
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith(";")) return;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      if (result[section]) throw new Error(`${url}:${index + 1}: duplicate section ${section}`);
      result[section] = Object.create(null);
      return;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!pair || !section) throw new Error(`${url}:${index + 1}: invalid INI entry`);
    const key = pair[1].trim();
    if (key in result[section]) throw new Error(`${url}:${index + 1}: duplicate key ${key}`);
    result[section][key] = pair[2].trim();
  });
  return result;
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
