import { documentKind, type EditorDocument, type ProjectAdapter, type ProjectEntry, type ProjectSnapshot } from "./types";

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
  update(path: string, content: string) { const document = this.require(path); document.content = content; document.dirty = content !== document.savedContent; this.changed(); }
  async saveFile(path: string) { if (!this.adapter) throw new Error("Open a package first."); const document = this.require(path); document.lastModified = await this.adapter.writeText(path, document.content); document.savedContent = document.content; document.dirty = false; document.externallyModified = false; this.changed(); }
  async saveAllFiles() { for (const document of this.openDocuments.filter(item => item.dirty)) await this.saveFile(document.path); }
  async checkExternalModifications() { if (!this.adapter) return []; const changed: EditorDocument[] = []; for (const document of this.openDocuments) { const stamp = await this.adapter.currentModified(document.path); if (stamp && document.lastModified && stamp !== document.lastModified) { document.externallyModified = true; changed.push(document); } } if (changed.length) this.changed(); return changed; }
  closeProject() { if (this.hasDirtyDocuments && !confirm("Close this project and discard unsaved changes?")) return false; this.adapter?.close?.(); this.adapter = undefined; this.documents.clear(); this.entries = []; this.changed(); return true; }
  private require(path: string) { const document = this.documents.get(path); if (!document) throw new Error(`Document is not open: ${path}`); return document; }
  private changed() { this.dispatchEvent(new Event("change")); }
}
