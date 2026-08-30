import { useEffect, useState } from "react";
import { parseIniDocument } from "../../engine/ini.js";
import { compileScript } from "../../engine/script.js";
import { DevelopmentGameProjectAdapter } from "./fileSystemAdapter";
import { EditorProjectService } from "./projectService";
import { SourceEditor } from "./SourceEditor";
import { hasFormSchema, IniForm } from "./iniForms";
import type { CompletionIndex } from "./editorLanguage";
import type { ProjectEntry } from "./types";
import { RoomDocument } from "./RoomDocument";
import { PlaytestHost } from "./PlaytestHost";

const service = new EditorProjectService();
const emptyIndex: CompletionIndex = { rooms: [], entities: [], spawns: [], items: [], graphics: [], animations: [], verbs: [], protocol: [], states: [] };

interface ExplorerNode { name: string; path: string; kind: "file" | "directory"; children: ExplorerNode[]; }

function explorerTree(entries: ProjectEntry[]) {
  const root: ExplorerNode = { name: "", path: "", kind: "directory", children: [] }, directories = new Map<string, ExplorerNode>([["", root]]);
  const directory = (path: string) => {
    const existing = directories.get(path); if (existing) return existing;
    const parts = path.split("/"), name = parts.pop()!, parentPath = parts.join("/"), node: ExplorerNode = { name, path, kind: "directory", children: [] };
    directory(parentPath).children.push(node); directories.set(path, node); return node;
  };
  for (const entry of entries) {
    if (entry.kind === "directory") directory(entry.path);
    else { const parts = entry.path.split("/"), name = parts.pop()!; directory(parts.join("/")).children.push({ name, path: entry.path, kind: "file", children: [] }); }
  }
  const sort = (nodes: ExplorerNode[]) => nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1).forEach(node => sort(node.children));
  sort(root.children); return root.children;
}

export default function App() {
  const [, render] = useState(0), [active, setActive] = useState<string>(), [output, setOutput] = useState("Ready."), [view, setView] = useState<"source" | "form" | "room" | "playtest">("source"), [diagnostics, setDiagnosticsState] = useState<any[]>([]), [index, setIndex] = useState(emptyIndex);
  const [filter, setFilter] = useState(""), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => { const update = () => render(value => value + 1); service.addEventListener("change", update); const timer = setInterval(() => service.checkExternalModifications().catch(() => {}), 3000); const unload = (event: BeforeUnloadEvent) => { if (service.hasDirtyDocuments) { event.preventDefault(); event.returnValue = ""; } }; addEventListener("beforeunload", unload); return () => { service.removeEventListener("change", update); clearInterval(timer); removeEventListener("beforeunload", unload); }; }, []);
  useEffect(() => { service.openPackageDirectory(new DevelopmentGameProjectAdapter()).catch(error => setOutput(String(error))); }, []);
  const documents = service.openDocuments, document = documents.find(item => item.path === active);
  const roomFiles = service.entries.filter(entry => entry.kind === "file" && /(^|\/)rooms\/[^/]+\/room\.ini$/i.test(entry.path));
  useEffect(() => {
    if (!document) { setDiagnosticsState([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const context = await service.languageContext(document.path); if (cancelled) return; setIndex(context.index);
      const result = document.path.endsWith(".ana") ? compileScript(document.content, context.compileContext) : parseIniDocument(document.content, document.path);
      setDiagnosticsState(result.diagnostics); setOutput(result.diagnostics.length ? `✕ ${result.diagnostics.length} diagnostic(s) in ${document.path}` : `✓ ${document.path}: valid`);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, document?.content]);
  const openFile = async (path: string) => { try { await service.readFile(path); setActive(path); setView(/rooms\/[^/]+\/room\.ini$/i.test(path) ? "room" : "source"); } catch (error) { setOutput(String(error)); } };
  const closeFile = (path: string) => { const index = documents.findIndex(item => item.path === path); if (!service.closeFile(path)) return; if (active === path) { const next = documents[index + 1] || documents[index - 1]; setActive(next?.path); if (next) setView(/rooms\/[^/]+\/room\.ini$/i.test(next.path) ? "room" : "source"); } };
  const toggleDirectory = (path: string) => setCollapsed(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const query = filter.trim().toLowerCase();
  const explorerNodes = (nodes: ExplorerNode[], depth = 0): React.ReactNode => nodes.map(node => {
    const matches = !query || node.path.toLowerCase().includes(query), visibleChildren = node.children.filter(child => child.kind === "directory" ? descendantMatches(child) : !query || child.path.toLowerCase().includes(query));
    if (node.kind === "file") return matches && <button className={`file ${node.path === active ? "selected" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} key={node.path} title={node.path} onClick={() => openFile(node.path)}><span>{node.name.endsWith(".ana") ? "◇" : "▤"}</span><span className="file-name">{node.name}</span></button>;
    if (!matches && !visibleChildren.length) return null;
    const isCollapsed = !query && collapsed.has(node.path);
    return <div className="tree-directory" key={node.path}><button className="directory" style={{ paddingLeft: 7 + depth * 14 }} onClick={() => toggleDirectory(node.path)} aria-expanded={!isCollapsed}><span className="chevron">{isCollapsed ? "›" : "⌄"}</span><span>▱</span><span className="file-name">{node.name}</span></button>{!isCollapsed && explorerNodes(visibleChildren, depth + 1)}</div>;
  });
  const descendantMatches = (node: ExplorerNode): boolean => !query || node.path.toLowerCase().includes(query) || node.children.some(descendantMatches);

  return <main className="app">
    <header><strong><span className="mark">A</span> Anachronist Editor</strong><span className="project">{service.project?.name || "No project open"}{service.hasDirtyDocuments && " • Unsaved"}</span><button disabled={!service.project} onClick={() => setView("playtest")}>Playtest</button><button disabled={!service.project} onClick={() => service.saveAllFiles().catch(error => setOutput(String(error)))}>Save all</button><button disabled={!service.project} onClick={() => { if (service.closeProject()) setActive(undefined); }}>Close</button></header>
    <aside className="explorer panel"><h2>PROJECT EXPLORER</h2>{!service.project ? <div className="empty"><b>Open the local game</b><p>Load the repository's game package.</p></div> : <><section className="room-shortcuts"><h2>ROOMS</h2>{roomFiles.length ? roomFiles.map(entry => { const id = /rooms\/([^/]+)\/room\.ini$/i.exec(entry.path)![1]; return <button key={entry.path} className={entry.path === active ? "selected" : ""} onClick={() => openFile(entry.path)}><span>▣</span><span>{id}</span><small>Open room</small></button>; }) : <p>No room.ini files found</p>}</section><div className="explorer-search"><span>⌕</span><input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter files" aria-label="Filter project files" /></div><nav>{explorerNodes(explorerTree(service.entries))}{query && !service.entries.some(entry => entry.kind === "file" && entry.path.toLowerCase().includes(query)) && <div className="no-results">No matching files</div>}</nav></>}</aside>
    <section className="workspace"><div className="tabs">{documents.map(doc => <button key={doc.path} className={doc.path === active ? "active" : ""} onClick={() => setActive(doc.path)}>{doc.externallyModified && <span>!</span>} <span className="tab-name">{doc.name}</span>{doc.dirty && <i>●</i>}<span className="tab-close" role="button" aria-label={`Close ${doc.name}`} title={`Close ${doc.name}`} onClick={event => { event.stopPropagation(); closeFile(doc.path); }}>×</span></button>)}</div>
      {view === "playtest" ? <PlaytestHost service={service} onClose={() => setView(document && /rooms\/[^/]+\/room\.ini$/i.test(document.path) ? "room" : "source")} /> : document ? <div className="document"><div className="crumb">{document.path} <span>{document.kind.toUpperCase()}</span>{/rooms\/[^/]+\/room\.ini$/i.test(document.path) && <button className={view === "room" ? "selected" : ""} onClick={() => setView("room")}>Room</button>}{hasFormSchema(document.path) && <button className={view === "form" ? "selected" : ""} onClick={() => setView("form")}>Form</button>}{/\.ini$/i.test(document.path) && <button className={view === "source" ? "selected" : ""} onClick={() => setView("source")}>INI source</button>}<button disabled={!document.dirty} onClick={() => service.saveFile(document.path).catch(error => setOutput(String(error)))}>Save</button></div>{document.externallyModified && <div className="warning">This file changed outside the editor. Review before saving.</div>}{view === "room" ? <RoomDocument path={document.path} source={document.content} service={service} onChange={content => service.update(document.path, content)} /> : view === "form" && hasFormSchema(document.path) ? <IniForm path={document.path} source={document.content} onChange={content => service.update(document.path, content)} /> : <SourceEditor path={document.path} value={document.content} diagnostics={diagnostics} index={index} onChange={content => service.update(document.path, content)} />}</div> : <div className="welcome"><div className="logo">A</div><h1>Adventure starts here</h1><p>Open an INI file or Anachronist script.</p></div>}
    </section>
    <aside className="inspector panel"><h2>INSPECTOR</h2>{document ? <dl><dt>Document</dt><dd>{document.name}</dd><dt>Type</dt><dd>{document.kind}</dd><dt>View</dt><dd>{view}</dd><dt>Status</dt><dd className={document.dirty ? "changed" : "saved"}>{document.dirty ? "Unsaved changes" : "Saved"}</dd><dt>Validation context</dt><dd>{document.path.includes("/rooms/") ? "Room" : document.path.includes("/items/") ? "Inventory" : "Package"}</dd></dl> : <div className="empty">Select a document to inspect it.</div>}</aside>
    <footer><div className="bottom-tabs"><b>DIAGNOSTICS</b><b>OUTPUT</b><span className={diagnostics.length ? "errors" : ""}>{diagnostics.length} error{diagnostics.length === 1 ? "" : "s"}</span></div><pre>{output}</pre></footer>
  </main>;
}
