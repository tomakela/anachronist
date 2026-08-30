import type { ProjectAdapter, ProjectEntry } from "./types";

type DirectoryHandle = FileSystemDirectoryHandle;

async function fileHandle(root: DirectoryHandle, path: string, create = false) {
  const parts = path.split("/").filter(Boolean);
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1)!, { create });
}

export class FileSystemProjectAdapter implements ProjectAdapter {
  readonly writable = true;
  readonly name: string;
  constructor(private root: DirectoryHandle) { this.name = root.name; }

  static async open() {
    const picker = (window as typeof window & { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (!picker) throw new Error("Directory access is unavailable in this browser.");
    return new FileSystemProjectAdapter(await picker());
  }

  async listFiles() {
    const entries: ProjectEntry[] = [];
    const visit = async (directory: DirectoryHandle, prefix = "") => {
      for await (const [name, handle] of directory.entries()) {
        if (name.startsWith(".")) continue;
        const path = `${prefix}${name}`;
        entries.push({ path, name, kind: handle.kind });
        if (handle.kind === "directory") await visit(handle, `${path}/`);
      }
    };
    await visit(this.root);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async readText(path: string) { const file = await (await fileHandle(this.root, path)).getFile(); return { content: await file.text(), lastModified: file.lastModified }; }
  async readBlob(path: string) { return (await fileHandle(this.root, path)).getFile(); }
  async writeText(path: string, content: string) { const handle = await fileHandle(this.root, path, true); const stream = await handle.createWritable(); await stream.write(content); await stream.close(); return (await handle.getFile()).lastModified; }
  async currentModified(path: string) { return (await (await fileHandle(this.root, path)).getFile()).lastModified; }
}

/** Read-only directory upload fallback. Saving downloads a replacement file. */
export class UploadProjectAdapter implements ProjectAdapter {
  readonly writable = false;
  readonly name: string;
  private files = new Map<string, File>();
  constructor(files: FileList) {
    for (const file of files) this.files.set(file.webkitRelativePath || file.name, file);
    this.name = [...this.files.keys()][0]?.split("/")[0] || "Uploaded project";
  }
  async listFiles() { return [...this.files.keys()].map(path => ({ path, name: path.split("/").at(-1)!, kind: "file" as const })); }
  async readText(path: string) { const file = this.files.get(path); if (!file) throw new Error(`File not found: ${path}`); return { content: await file.text(), lastModified: file.lastModified }; }
  async readBlob(path: string) { const file = this.files.get(path); if (!file) throw new Error(`File not found: ${path}`); return file; }
  async writeText(path: string, content: string) { const blob = new Blob([content], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = path.split("/").at(-1)!; link.click(); URL.revokeObjectURL(link.href); return undefined; }
  async currentModified(path: string) { return this.files.get(path)?.lastModified; }
}
