import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";

// Anachronist and INI use Monarch tokenizers, so the core editor worker is all
// that is required. Vite emits it with the application for offline projects.
(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
