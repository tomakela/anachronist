import { useEffect, useRef, useState } from "react";
import { parseIniDocument } from "../../engine/ini.js";
import { compileScript } from "../../engine/script.js";
import { FileSystemProjectAdapter, UploadProjectAdapter } from "./fileSystemAdapter";
import { EditorProjectService } from "./projectService";
import { SourceEditor } from "./SourceEditor";
import { hasFormSchema, IniForm } from "./iniForms";
import type { CompletionIndex } from "./editorLanguage";
import { RoomDocument } from "./RoomDocument";

const service = new EditorProjectService();
const emptyIndex: CompletionIndex = { rooms: [], entities: [], spawns: [], items: [], graphics: [], animations: [], verbs: [], protocol: [], states: [] };

export default function App() {
  const [, render] = useState(0), [active, setActive] = useState<string>(), [output, setOutput] = useState("Ready."), [view, setView] = useState<"source" | "form" | "room">("source"), [diagnostics, setDiagnosticsState] = useState<any[]>([]), [index, setIndex] = useState(emptyIndex);
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => { const update = () => render(value => value + 1); service.addEventListener("change", update); const timer = setInterval(() => service.checkExternalModifications().catch(() => {}), 3000); const unload = (event: BeforeUnloadEvent) => { if (service.hasDirtyDocuments) { event.preventDefault(); event.returnValue = ""; } }; addEventListener("beforeunload", unload); return () => { service.removeEventListener("change", update); clearInterval(timer); removeEventListener("beforeunload", unload); }; }, []);
  const documents = service.openDocuments, document = documents.find(item => item.path === active);
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
  const openDirectory = async () => { try { await service.openPackageDirectory(await FileSystemProjectAdapter.open()); } catch (error) { setOutput(String(error)); upload.current?.click(); } };
  const openUpload = async (files: FileList | null) => { if (files?.length) await service.openPackageDirectory(new UploadProjectAdapter(files)); };
  const openFile = async (path: string) => { try { await service.readFile(path); setActive(path); setView(/rooms\/[^/]+\/room\.ini$/.test(path) ? "room" : "source"); } catch (error) { setOutput(String(error)); } };

  return <main className="app">
    <header><strong><span className="mark">A</span> Anachronist Editor</strong><span className="project">{service.project?.name || "No project open"}{service.hasDirtyDocuments && " • Unsaved"}</span><button onClick={openDirectory}>Open folder</button><button disabled={!service.project} onClick={() => service.saveAllFiles().catch(error => setOutput(String(error)))}>Save all</button><button disabled={!service.project} onClick={() => { if (service.closeProject()) setActive(undefined); }}>Close</button><input ref={upload} hidden type="file" // @ts-expect-error Chromium directory upload
      webkitdirectory="" multiple onChange={event => openUpload(event.target.files)} /></header>
    <aside className="explorer panel"><h2>PROJECT EXPLORER</h2>{!service.project ? <div className="empty"><b>Open a game package</b><p>Select a folder to begin editing.</p></div> : <nav>{service.entries.filter(entry => entry.kind === "file").map(entry => <button className="file" key={entry.path} onClick={() => openFile(entry.path)}><span>{entry.name.endsWith(".ana") ? "◇" : "▤"}</span>{entry.path}</button>)}</nav>}</aside>
    <section className="workspace"><div className="tabs">{documents.map(doc => <button key={doc.path} className={doc.path === active ? "active" : ""} onClick={() => setActive(doc.path)}>{doc.externallyModified && <span>!</span>} {doc.name}{doc.dirty && <i> ●</i>}</button>)}</div>
      {document ? <div className="document"><div className="crumb">{document.path} <span>{document.kind.toUpperCase()}</span>{/rooms\/[^/]+\/room\.ini$/.test(document.path) && <button className={view === "room" ? "selected" : ""} onClick={() => setView("room")}>Room</button>}{hasFormSchema(document.path) && <><button className={view === "form" ? "selected" : ""} onClick={() => setView("form")}>Form</button><button className={view === "source" ? "selected" : ""} onClick={() => setView("source")}>Source</button></>}<button disabled={!document.dirty} onClick={() => service.saveFile(document.path).catch(error => setOutput(String(error)))}>Save</button></div>{document.externallyModified && <div className="warning">This file changed outside the editor. Review before saving.</div>}{view === "room" ? <RoomDocument path={document.path} source={document.content} service={service} onChange={content => service.update(document.path, content)} /> : view === "form" && hasFormSchema(document.path) ? <IniForm path={document.path} source={document.content} onChange={content => service.update(document.path, content)} /> : <SourceEditor path={document.path} value={document.content} diagnostics={diagnostics} index={index} onChange={content => service.update(document.path, content)} />}</div> : <div className="welcome"><div className="logo">A</div><h1>Adventure starts here</h1><p>Open an INI file or Anachronist script.</p></div>}
    </section>
    <aside className="inspector panel"><h2>INSPECTOR</h2>{document ? <dl><dt>Document</dt><dd>{document.name}</dd><dt>Type</dt><dd>{document.kind}</dd><dt>View</dt><dd>{view}</dd><dt>Status</dt><dd className={document.dirty ? "changed" : "saved"}>{document.dirty ? "Unsaved changes" : "Saved"}</dd><dt>Validation context</dt><dd>{document.path.includes("/rooms/") ? "Room" : document.path.includes("/items/") ? "Inventory" : "Package"}</dd></dl> : <div className="empty">Select a document to inspect it.</div>}</aside>
    <footer><div className="bottom-tabs"><b>DIAGNOSTICS</b><b>OUTPUT</b><span className={diagnostics.length ? "errors" : ""}>{diagnostics.length} error{diagnostics.length === 1 ? "" : "s"}</span></div><pre>{output}</pre></footer>
  </main>;
}
