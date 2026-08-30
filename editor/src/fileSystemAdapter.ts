import type { ProjectAdapter, ProjectEntry } from "./types";

type DirectoryHandle = FileSystemDirectoryHandle;

function projectPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => !part || part === "." || part === "..")) throw new Error(`Invalid project file path: ${path || "(empty)"}`);
  return parts;
}

async function fileHandle(root: DirectoryHandle, path: string, create = false) {
  const parts = projectPath(path);
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1)!, { create });
}

export class FileSystemProjectAdapter implements ProjectAdapter {
  readonly writable = true;
  readonly name: string;
  private files = new Map<string, FileSystemFileHandle>();
  constructor(private root: DirectoryHandle) { this.name = root.name; }

  static async open() {
    const picker = (window as typeof window & { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (!picker) throw new Error("Directory access is unavailable in this browser.");
    return new FileSystemProjectAdapter(await picker.call(window));
  }

  async listFiles() {
    const entries: ProjectEntry[] = [];
    this.files.clear();
    const visit = async (directory: DirectoryHandle, prefix = "") => {
      const handles = directory.values
        ? directory.values()
        : (async function* () { for await (const [, handle] of directory.entries()) yield handle; })();
      for await (const handle of handles) {
        const { name } = handle;
        if (name.startsWith(".")) continue;
        const path = `${prefix}${name}`;
        entries.push({ path, name, kind: handle.kind });
        if (handle.kind === "directory") await visit(handle, `${path}/`);
        else this.files.set(path, handle);
      }
    };
    await visit(this.root);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  private async existingFile(path: string) {
    const normalized = projectPath(path).join("/");
    const handle = this.files.get(normalized) || await fileHandle(this.root, normalized);
    this.files.set(normalized, handle);
    return handle;
  }
  async readText(path: string) { const file = await (await this.existingFile(path)).getFile(); return { content: await file.text(), lastModified: file.lastModified }; }
  async readBlob(path: string) { return (await this.existingFile(path)).getFile(); }
  async writeText(path: string, content: string) {
    const normalized = projectPath(path).join("/");
    const handle = this.files.get(normalized) || await fileHandle(this.root, normalized, true);
    this.files.set(normalized, handle);
    const stream = await handle.createWritable(); await stream.write(content); await stream.close(); return (await handle.getFile()).lastModified;
  }
  async currentModified(path: string) { return (await (await this.existingFile(path)).getFile()).lastModified; }
}

/** Read-only directory upload fallback. Saving downloads a replacement file. */
export class UploadProjectAdapter implements ProjectAdapter {
  readonly writable = false;
  readonly name: string;
  private files = new Map<string, File>();
  constructor(files: FileList) {
    const uploaded = [...files].map(file => ({ file, parts: projectPath(file.webkitRelativePath || file.name) }));
    const wrapper = uploaded.length && uploaded.every(({ parts }) => parts.length > 1 && parts[0] === uploaded[0].parts[0]) ? uploaded[0].parts[0] : undefined;
    for (const { file, parts } of uploaded) this.files.set(parts.slice(wrapper ? 1 : 0).join("/"), file);
    this.name = wrapper || "Uploaded project";
  }
  async listFiles() { return [...this.files.keys()].map(path => ({ path, name: path.split("/").at(-1)!, kind: "file" as const })); }
  async readText(path: string) { const file = this.files.get(path); if (!file) throw new Error(`File not found: ${path}`); return { content: await file.text(), lastModified: file.lastModified }; }
  async readBlob(path: string) { const file = this.files.get(path); if (!file) throw new Error(`File not found: ${path}`); return file; }
  async writeText(path: string, content: string) { const blob = new Blob([content], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = path.split("/").at(-1)!; link.click(); URL.revokeObjectURL(link.href); return undefined; }
  async currentModified(path: string) { return this.files.get(path)?.lastModified; }
}

/** Reads the repository-local game exposed by the Vite development server. */
export class DevelopmentGameProjectAdapter implements ProjectAdapter {
  readonly writable = false;
  readonly name = "Anachronist demo game";
  async listFiles() {
    const paths = await fetch("/__anachronist-game/entries").then(response => {
      if (!response.ok) throw new Error("The development game files are unavailable.");
      return response.json() as Promise<string[]>;
    });
    return paths.map(path => ({ path, name: path.split("/").at(-1)!, kind: "file" as const }));
  }
  async readText(path: string) {
    const response = await fetch(`/__anachronist-game/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`File not found: ${path}`);
    return { content: await response.text() };
  }
  async readBlob(path: string) {
    const response = await fetch(`/__anachronist-game/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`File not found: ${path}`);
    return response.blob();
  }
  async writeText(): Promise<number | undefined> { throw new Error("The development game fallback is read-only."); }
  async currentModified() { return undefined; }
}
