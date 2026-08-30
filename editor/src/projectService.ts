import { documentKind, type EditorDocument, type ProjectAdapter, type ProjectEntry, type ProjectSnapshot } from "./types";
import { parseIniDocument } from "../../engine/ini.js";
import type { CompletionIndex } from "./editorLanguage";

export class EditorProjectService extends EventTarget {
  private adapter?: ProjectAdapter;
  private documents = new Map<string, EditorDocument>();
  entries: ProjectEntry[] = [];
  contentRevision = 0;

  get openDocuments() { return [...this.documents.values()]; }
  get hasDirtyDocuments() { return this.openDocuments.some(document => document.dirty); }
  get project(): ProjectSnapshot | undefined { return this.adapter && { name: this.adapter.name, entries: this.entries, writable: this.adapter.writable }; }

  async openPackageDirectory(adapter: ProjectAdapter) {
    if (this.hasDirtyDocuments && !confirm("Discard unsaved changes and open another project?")) return false;
    const allEntries = await adapter.listFiles();
    await this.discoverConfigurationFiles(adapter, allEntries);
    const gameFiles = allEntries.filter(entry => entry.kind === "file" && /(^|\/)game\.ini$/i.test(entry.path));
    const packageEntry = gameFiles.find(entry => entry.path === "game.ini")
      || (gameFiles.length === 1 ? gameFiles[0] : undefined);
    const packageRoot = packageEntry?.path.slice(0, -"game.ini".length) || "";
    this.adapter?.close?.(); this.adapter = adapter; this.documents.clear();
    this.entries = allEntries
      .filter(entry => !packageRoot || entry.path.startsWith(packageRoot));
    this.changed(true); return true;
  }
  async readFile(path: string) {
    const existing = this.documents.get(path); if (existing) return existing;
    if (!this.adapter) throw new Error("Open a package first.");
    const { content, lastModified } = await this.adapter.readText(path);
    const document: EditorDocument = { id: path, path, name: path.split("/").at(-1)!, kind: documentKind(path), content, savedContent: content, dirty: false, externallyModified: false, lastModified };
    this.documents.set(path, document); this.changed(); return document;
  }
  async readProjectText(path: string) {
    const open = this.documents.get(path);
    if (open) return open.content;
    if (!this.adapter) throw new Error("Open a package first.");
    return (await this.adapter.readText(path)).content;
  }
  async readProjectBlob(path: string) {
    const open = this.documents.get(path);
    if (open) return new Blob([open.content]);
    if (!this.adapter) throw new Error("Open a package first.");
    if (this.adapter.readBlob) return this.adapter.readBlob(path);
    return new Blob([(await this.adapter.readText(path)).content]);
  }
  async languageContext(path: string): Promise<{ compileContext: Record<string, unknown>; index: CompletionIndex }> {
    if (!this.adapter) return { compileContext: { path }, index: { rooms: [], entities: [], spawns: [], items: [], graphics: [], animations: [], verbs: [], protocol: [], states: [] } };
    const iniPaths = this.entries.filter(entry => entry.kind === "file" && /\.ini$/i.test(entry.path)).map(entry => entry.path);
    const parsed = new Map<string, any>();
    await Promise.all(iniPaths.map(async iniPath => { try { const open = this.documents.get(iniPath); parsed.set(iniPath, parseIniDocument(open?.content ?? (await this.adapter!.readText(iniPath)).content, iniPath).value); } catch { /* incomplete files do not prevent completion */ } }));
    const sections = [...parsed.values()].flatMap(value => Object.keys(value));
    const ids = (prefix: string) => [...new Set(sections.filter(section => section.startsWith(prefix)).map(section => section.slice(prefix.length)))];
    const rooms = ids("room."), entities = ids("entity."), spawns = ids("spawn."), items = ids("inventory."), graphics = ids("graphic."), animations = ids("animation."), verbs = ids("verb.");
    const states: string[] = [];
    for (const [iniPath, value] of parsed) { const room = /rooms\/([^/]+)\/room\.ini$/.exec(iniPath)?.[1], scope = /game\.ini$/.test(iniPath) ? "game" : room; if (scope) states.push(...Object.keys(value.$variables || {}).map(key => `${scope}.${key}`)); }
    const game = [...parsed.entries()].find(([iniPath]) => /game\/game\.ini$/.test(iniPath))?.[1];
    const protocol = Object.values(game?.protocol || {}).map(String);
    const index = { rooms, entities, spawns, items, graphics, animations, verbs, protocol, states };
    const compileContext: Record<string, unknown> = { path };
    const roomMatch = /rooms\/([^/]+)\/[^/]+\.ana$/.exec(path), itemMatch = /items\/([^/]+)\.ana$/.exec(path);
    if (roomMatch) { compileContext.roomId = roomMatch[1]; const roomIni = [...parsed.entries()].find(([iniPath]) => iniPath.endsWith(`/rooms/${roomMatch[1]}/room.ini`))?.[1]; compileContext.entities = Object.keys(roomIni || {}).filter(key => key.startsWith("entity.")).map(key => key.slice(7)); }
    else if (itemMatch) compileContext.itemId = itemMatch[1];
    return { compileContext, index };
  }
  update(path: string, content: string) { const document = this.require(path); document.content = content; document.dirty = content !== document.savedContent; this.changed(true); }
  closeFile(path: string) { const document = this.require(path); if (document.dirty && !confirm(`Close ${document.name} and discard unsaved changes?`)) return false; this.documents.delete(path); this.changed(); return true; }
  async saveFile(path: string) { if (!this.adapter) throw new Error("Open a package first."); const document = this.require(path); document.lastModified = await this.adapter.writeText(path, document.content); document.savedContent = document.content; document.dirty = false; document.externallyModified = false; this.changed(); }
  async saveAllFiles() { for (const document of this.openDocuments.filter(item => item.dirty)) await this.saveFile(document.path); }
  async checkExternalModifications() { if (!this.adapter) return []; const changed: EditorDocument[] = []; for (const document of this.openDocuments) { const stamp = await this.adapter.currentModified(document.path); if (stamp && document.lastModified && stamp !== document.lastModified) { document.externallyModified = true; changed.push(document); } } if (changed.length) this.changed(true); return changed; }
  closeProject() { if (this.hasDirtyDocuments && !confirm("Close this project and discard unsaved changes?")) return false; this.adapter?.close?.(); this.adapter = undefined; this.documents.clear(); this.entries = []; this.changed(true); return true; }
  private require(path: string) { const document = this.documents.get(path); if (!document) throw new Error(`Document is not open: ${path}`); return document; }
  private async discoverConfigurationFiles(adapter: ProjectAdapter, entries: ProjectEntry[]) {
    if (entries.some(entry => entry.kind === "file" && /\.ini$/i.test(entry.path))) return;
    const known = new Set(entries.filter(entry => entry.kind === "directory").map(entry => `${entry.path}/game.ini`));
    known.add("game.ini");
    const packageRoots = new Set<string>();
    const checked = new Set<string>();
    while (known.size) {
      const path = known.values().next().value as string;
      known.delete(path);
      if (checked.has(path)) continue;
      checked.add(path);
      try {
        const content = (await adapter.readText(path)).content;
        entries.push({ path, name: path.split("/").at(-1)!, kind: "file" });
        const base = path.endsWith("game.ini") ? path.slice(0, -"game.ini".length) : path.slice(0, path.lastIndexOf("/") + 1);
        if (path.endsWith("game.ini")) packageRoots.add(base);
        const value = parseIniDocument(content, path).value;
        for (const section of Object.values(value) as Record<string, unknown>[]) for (const reference of Object.values(section)) {
          if (typeof reference !== "string" || !/\.ini$/i.test(reference)) continue;
          for (const root of packageRoots.size ? packageRoots : [base]) known.add(`${root}${reference}`.replaceAll("//", "/"));
          known.add(`${base}${reference}`.replaceAll("//", "/"));
        }
      } catch { /* The candidate is not present or is not an INI document. */ }
    }
  }
  private changed(contentChanged = false) { if (contentChanged) this.contentRevision++; this.dispatchEvent(new Event("change")); }
}
