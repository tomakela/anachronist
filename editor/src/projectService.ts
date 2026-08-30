import { documentKind, type EditorDocument, type ProjectAdapter, type ProjectEntry, type ProjectSnapshot } from "./types";
import { parseIniDocument } from "../../engine/ini.js";
import type { CompletionIndex } from "./editorLanguage";

export class EditorProjectService extends EventTarget {
  private adapter?: ProjectAdapter;
  private documents = new Map<string, EditorDocument>();
  entries: ProjectEntry[] = [];

  get openDocuments() { return [...this.documents.values()]; }
  get hasDirtyDocuments() { return this.openDocuments.some(document => document.dirty); }
  get project(): ProjectSnapshot | undefined { return this.adapter && { name: this.adapter.name, entries: this.entries, writable: this.adapter.writable }; }

  async openPackageDirectory(adapter: ProjectAdapter) {
    if (this.hasDirtyDocuments && !confirm("Discard unsaved changes and open another project?")) return false;
    this.adapter?.close?.(); this.adapter = adapter; this.documents.clear(); this.entries = await adapter.listFiles(); this.changed(); return true;
  }
  async readFile(path: string) {
    const existing = this.documents.get(path); if (existing) return existing;
    if (!this.adapter) throw new Error("Open a package first.");
    const { content, lastModified } = await this.adapter.readText(path);
    const document: EditorDocument = { id: path, path, name: path.split("/").at(-1)!, kind: documentKind(path), content, savedContent: content, dirty: false, externallyModified: false, lastModified };
    this.documents.set(path, document); this.changed(); return document;
  }
  async languageContext(path: string): Promise<{ compileContext: Record<string, unknown>; index: CompletionIndex }> {
    if (!this.adapter) return { compileContext: { path }, index: { rooms: [], entities: [], spawns: [], items: [], graphics: [], animations: [], verbs: [], protocol: [], states: [] } };
    const iniPaths = this.entries.filter(entry => entry.kind === "file" && entry.path.endsWith(".ini")).map(entry => entry.path);
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
  update(path: string, content: string) { const document = this.require(path); document.content = content; document.dirty = content !== document.savedContent; this.changed(); }
  async saveFile(path: string) { if (!this.adapter) throw new Error("Open a package first."); const document = this.require(path); document.lastModified = await this.adapter.writeText(path, document.content); document.savedContent = document.content; document.dirty = false; document.externallyModified = false; this.changed(); }
  async saveAllFiles() { for (const document of this.openDocuments.filter(item => item.dirty)) await this.saveFile(document.path); }
  async checkExternalModifications() { if (!this.adapter) return []; const changed: EditorDocument[] = []; for (const document of this.openDocuments) { const stamp = await this.adapter.currentModified(document.path); if (stamp && document.lastModified && stamp !== document.lastModified) { document.externallyModified = true; changed.push(document); } } if (changed.length) this.changed(); return changed; }
  closeProject() { if (this.hasDirtyDocuments && !confirm("Close this project and discard unsaved changes?")) return false; this.adapter?.close?.(); this.adapter = undefined; this.documents.clear(); this.entries = []; this.changed(); return true; }
  private require(path: string) { const document = this.documents.get(path); if (!document) throw new Error(`Document is not open: ${path}`); return document; }
  private changed() { this.dispatchEvent(new Event("change")); }
}
