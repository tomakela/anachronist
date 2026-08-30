import { useEffect, useRef, useState } from "react";
import { parseIni } from "../../engine/ini.js";
import { compile } from "../../engine/script.js";
import { FileSystemProjectAdapter, UploadProjectAdapter } from "./fileSystemAdapter";
import { EditorProjectService } from "./projectService";
import type { EditorDocument } from "./types";

const service = new EditorProjectService();

export default function App() {
  const [, render] = useState(0); const [active, setActive] = useState<string>(); const [output, setOutput] = useState("Ready."); const upload = useRef<HTMLInputElement>(null);
  useEffect(() => { const update = () => render(value => value + 1); service.addEventListener("change", update); const timer = setInterval(() => service.checkExternalModifications().catch(() => {}), 3000); const unload = (event: BeforeUnloadEvent) => { if (service.hasDirtyDocuments) { event.preventDefault(); event.returnValue = ""; } }; addEventListener("beforeunload", unload); return () => { service.removeEventListener("change", update); clearInterval(timer); removeEventListener("beforeunload", unload); }; }, []);
  const documents = service.openDocuments; const document = documents.find(item => item.path === active);
  const openDirectory = async () => { try { await service.openPackageDirectory(await FileSystemProjectAdapter.open()); } catch (error) { setOutput(String(error)); upload.current?.click(); } };
  const openUpload = async (files: FileList | null) => { if (files?.length) await service.openPackageDirectory(new UploadProjectAdapter(files)); };
  const openFile = async (path: string) => { try { await service.readFile(path); setActive(path); } catch (error) { setOutput(String(error)); } };
  const validate = (doc: EditorDocument) => { try { const result = doc.kind === "script" ? compile(doc.content) : parseIni(doc.content, doc.path); setOutput(`✓ ${doc.path}: valid (${Object.keys(result).length} top-level entries)`); } catch (error) { setOutput(`✕ ${String(error)}`); } };

  return <main className="app">
    <header><strong><span className="mark">A</span> Anachronist Editor</strong><span className="project">{service.project?.name || "No project open"}{service.hasDirtyDocuments && " • Unsaved"}</span><button onClick={openDirectory}>Open folder</button><button disabled={!service.project} onClick={() => service.saveAllFiles().catch(error => setOutput(String(error)))}>Save all</button><button disabled={!service.project} onClick={() => { if (service.closeProject()) setActive(undefined); }}>Close</button><input ref={upload} hidden type="file" // @ts-expect-error webkitdirectory is supported by Chromium
      webkitdirectory="" multiple onChange={event => openUpload(event.target.files)} /></header>
    <aside className="explorer panel"><h2>PROJECT EXPLORER</h2>{!service.project ? <div className="empty"><b>Open a game package</b><p>Select a folder to begin editing.</p></div> : <nav>{service.entries.filter(entry => entry.kind === "file").map(entry => <button className="file" key={entry.path} onClick={() => openFile(entry.path)}><span>{entry.name.endsWith(".ana") ? "◇" : "▤"}</span>{entry.path}</button>)}</nav>}</aside>
    <section className="workspace">
      <div className="tabs">{documents.map(doc => <button key={doc.path} className={doc.path === active ? "active" : ""} onClick={() => setActive(doc.path)}>{doc.externallyModified && <span title="Externally modified">!</span>} {doc.name}{doc.dirty && <i> ●</i>}</button>)}</div>
      {document ? <div className="document"><div className="crumb">{document.path} <span>{document.kind.toUpperCase()}</span><button onClick={() => validate(document)}>Validate</button><button disabled={!document.dirty} onClick={() => service.saveFile(document.path).catch(error => setOutput(String(error)))}>Save</button></div>{document.externallyModified && <div className="warning">This file changed outside the editor. Review before saving.</div>}<textarea spellCheck={false} value={document.content} onChange={event => service.update(document.path, event.target.value)} /></div> : <div className="welcome"><div className="logo">A</div><h1>Adventure starts here</h1><p>Open an INI file, Anachronist script, room visualization, or playtest session.</p></div>}
    </section>
    <aside className="inspector panel"><h2>INSPECTOR</h2>{document ? <dl><dt>Document</dt><dd>{document.name}</dd><dt>Type</dt><dd>{document.kind}</dd><dt>Status</dt><dd className={document.dirty ? "changed" : "saved"}>{document.dirty ? "Unsaved changes" : "Saved"}</dd><dt>Engine integration</dt><dd>Shared parser & compiler</dd></dl> : <div className="empty">Select a document to inspect it.</div>}</aside>
    <footer><div className="bottom-tabs"><b>DIAGNOSTICS</b><b>OUTPUT</b><span>0 errors</span></div><pre>{output}</pre></footer>
  </main>;
}
