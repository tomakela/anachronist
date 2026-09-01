import { parseIniDocument } from "../../engine/ini.js";

type Field = { key: string; label?: string; type?: "text" | "number" | "boolean" | "select"; options?: string[] };
const fields = (...keys: string[]): Field[] => keys.map(key => ({ key, label: key.replaceAll("_", " ") }));
const schemas: Record<string, Field[]> = {
  package: fields("id", "format_version", "script_language_version", "entry_script", "resource_catalogue", "room_catalogue", "interface", "item_catalogue"),
  display: fields("logical_width", "logical_height", "bit_depth", "scaling_filter", "aspect_policy", "orientation_policy"),
  runtime: fields("ticks_per_second", "walk_speed", "fast_walk_multiplier", "shake_amplitude", "text_base_ticks", "text_ticks_per_character", "text_minimum_ticks", "language", "random_seed_policy"),
  input: fields("bindings", "dragging_sensitivity", "long_touch_milliseconds", "long_touch_move_tolerance", "double_touch_milliseconds", "double_touch_move_tolerance"),
  save: fields("format_version", "slot_policy"), protocol: fields("walk_command", "take_command", "player_actor", "look_verb", "use_verb", "use_animation", "pickup_animation"),
  room: fields("background_color", "background_graphic", "interactive", "interface_visible", "fullscreen", "player_scaling", "player_walk_speed_scaling"),
  entity: fields("label", "graphic", "position", "size", "origin", "walk_to", "suggested_verb", "visible", "enabled", "interactive", "rotation", "hotspot_rect", "hotspot_polygon"),
  spawn: fields("position"), trigger: fields("rect"), inventory: fields("label", "graphic", "suggested_verb", "script"),
  graphic: fields("path", "mime_type", "width", "height", "missing_color", "frames"), animation: fields("graphic", "width", "height", "frames"),
  catalogue: fields("format_version", "rooms", "items", "graphics", "player_animations"), action: fields("pointer_button", "touch", "keyboard_code"),
  interface: fields("default_verb", "accessible_label", "font"), verb: fields("label", "preposition", "object_preposition", "rect"), fallback: fields("text")
};

export function replaceIniProperty(source: string, path: string, section: string | null, key: string, value: string) {
  const document = parseIniDocument(source, path);
  const property = document.nodes.find((node: any) => node.type === "property" && node.section === section && node.key === key) as any;
  if (property) return source.slice(0, property.valueRange.start.offset) + value + source.slice(property.valueRange.end.offset);
  if (section === null) {
    const firstSection = document.nodes.find((node: any) => node.type === "section") as any;
    const at = firstSection?.range.start.offset ?? source.length;
    return source.slice(0, at) + `${key} = ${value}\n` + source.slice(at);
  }
  const heading = document.nodes.find((node: any) => node.type === "section" && node.name === section) as any;
  if (!heading) return `${source}${source.endsWith("\n") ? "" : "\n"}\n[${section}]\n${key} = ${value}\n`;
  const following = document.nodes.find((node: any) => node.type === "section" && node.range.start.offset > heading.range.start.offset) as any;
  const at = following?.range.start.offset ?? source.length, prefix = at && source[at - 1] !== "\n" ? "\n" : "";
  return source.slice(0, at) + `${prefix}${key} = ${value}\n` + source.slice(at);
}

export const hasFormSchema = (path: string) => path.endsWith(".ini") && (/game\/(game|interface|input)\.ini$/.test(path) || /room\.ini$/.test(path) || /resources\/.*\.ini$/.test(path) || /items\/inventory\.ini$/.test(path) || /rooms\/index\.ini$/.test(path));

export function IniForm({ path, source, onChange }: { path: string; source: string; onChange(source: string): void }) {
  const document = parseIniDocument(source, path), sections = Object.keys(document.value);
  return <div className="ini-form">
    {Object.keys(document.value.$variables || {}).length > 0 && <FormSection title="State variables" section={null} values={document.value.$variables} schema={Object.keys(document.value.$variables).map(key => ({ key }))} />}
    {sections.map(section => { const family = section.split(".")[0], schema = schemas[section] || schemas[family]; return schema && <FormSection key={section} title={section} section={section} values={document.value[section]} schema={schema} />; })}
  </div>;
  function FormSection({ title, section, values, schema }: { title: string; section: string | null; values: Record<string, string>; schema: Field[] }) {
    return <fieldset><legend>{title}</legend>{schema.map(field => <label key={field.key}><span>{field.label || field.key}</span><input value={values[field.key] ?? ""} type={field.type === "number" ? "number" : "text"} onChange={event => onChange(replaceIniProperty(source, path, section, field.key, event.target.value))} /></label>)}</fieldset>;
  }
}
