export type DocumentKind = "ini" | "script" | "room" | "playtest";

export interface EditorDocument {
  id: string;
  path: string;
  name: string;
  kind: DocumentKind;
  content: string;
  savedContent: string;
  dirty: boolean;
  externallyModified: boolean;
  lastModified?: number;
}

export interface ProjectEntry { path: string; name: string; kind: "file" | "directory"; }
export interface ProjectSnapshot { name: string; entries: ProjectEntry[]; writable: boolean; }

export interface ProjectAdapter {
  readonly writable: boolean;
  readonly name: string;
  listFiles(): Promise<ProjectEntry[]>;
  readText(path: string): Promise<{ content: string; lastModified?: number }>;
  readBlob?(path: string): Promise<Blob>;
  writeText(path: string, content: string): Promise<number | undefined>;
  currentModified(path: string): Promise<number | undefined>;
  close?(): void;
}

export const documentKind = (path: string): DocumentKind => {
  if (path.endsWith(".ini")) return path.includes("room") ? "room" : "ini";
  if (path.endsWith(".ana")) return "script";
  return "ini";
};
