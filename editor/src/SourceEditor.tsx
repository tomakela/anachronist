import { useEffect } from "react";
import Editor, { loader, type OnMount, useMonaco } from "@monaco-editor/react";
import * as monacoLocal from "monaco-editor";
import "./monacoWorkers";
import { registerEditorLanguages, setCompletionIndex, setDiagnostics, type CompletionIndex } from "./editorLanguage";

// Keep the editor self-contained rather than relying on the Monaco CDN.
loader.config({ monaco: monacoLocal });

export function SourceEditor({ path, value, diagnostics, index, onChange }: { path: string; value: string; diagnostics: any[]; index: CompletionIndex; onChange(value: string): void }) {
  const uri = `file:///${path}`;
  const monaco = useMonaco();
  useEffect(() => { const model = monaco?.editor.getModel(monaco.Uri.parse(uri)); if (monaco && model) { setCompletionIndex(model.uri.toString(), index); setDiagnostics(monaco, model, diagnostics); } }, [monaco, uri, diagnostics, index]);
  const mount: OnMount = (editor, monaco) => { registerEditorLanguages(monaco); const model = editor.getModel(); if (model) { setCompletionIndex(model.uri.toString(), index); setDiagnostics(monaco, model, diagnostics); } };
  return <Editor path={uri} language={path.endsWith(".ana") ? "anachronist" : "anachronist-ini"} theme="vs-dark" value={value} onChange={next => onChange(next ?? "")} onMount={mount} options={{ minimap: { enabled: false }, fontSize: 14, tabSize: 2, automaticLayout: true, scrollBeyondLastLine: false }} />;
}
