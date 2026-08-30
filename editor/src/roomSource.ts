import { parseIniDocument } from "../../engine/ini.js";

/** Replace only one property value, preserving all unrelated source and comments. */
export function editIniProperty(source: string, section: string, key: string, value: string) {
  const document = parseIniDocument(source);
  const node = document.nodes.find((item: any) => item.type === "property" && item.section === section && item.key === key);
  if (node) return source.slice(0, node.valueRange.start.offset) + value + source.slice(node.valueRange.end.offset);
  const heading = document.nodes.find((item: any) => item.type === "section" && item.name === section);
  if (!heading) return `${source.replace(/\s*$/, "\n\n")}[${section}]\n${key} = ${value}\n`;
  const next = document.nodes.find((item: any) => item.type === "section" && item.range.start.offset > heading.range.start.offset);
  const offset = next?.range.start.offset ?? source.length;
  return source.slice(0, offset).replace(/\s*$/, "\n") + `${key} = ${value}\n\n` + source.slice(offset);
}
