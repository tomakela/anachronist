import type * as Monaco from "monaco-editor";

export interface CompletionIndex {
  rooms: string[]; entities: string[]; spawns: string[]; items: string[];
  graphics: string[]; animations: string[]; verbs: string[]; protocol: string[]; states: string[];
}

const emptyIndex: CompletionIndex = { rooms: [], entities: [], spawns: [], items: [], graphics: [], animations: [], verbs: [], protocol: [], states: [] };
const indexes = new Map<string, CompletionIndex>();
export const setCompletionIndex = (uri: string, index?: CompletionIndex) => indexes.set(uri, index || emptyIndex);

export function registerEditorLanguages(monaco: typeof Monaco) {
  if (monaco.languages.getLanguages().some(language => language.id === "anachronist")) return;
  monaco.languages.register({ id: "anachronist", extensions: [".ana"], aliases: ["Anachronist", "ana"] });
  monaco.languages.setLanguageConfiguration("anachronist", { comments: { lineComment: "//" }, brackets: [["{", "}"], ["(", ")"]], autoClosingPairs: [{ open: "{", close: "}" }, { open: "(", close: ")" }, { open: '"', close: '"' }] });
  monaco.languages.setMonarchTokensProvider("anachronist", {
    defaultToken: "identifier",
    keywords: ["on", "task", "skippable"], commands: ["sequence", "loop", "if", "else", "walk", "say", "narrate", "take", "show", "hide", "enable", "disable", "remove", "replace", "enter", "set", "wait", "await", "shake", "spawn", "face"],
    tokenizer: { root: [
      [/\/\/.*$/, "comment"], [/"(?:\\.|[^"\\])*"/, "string"], [/-?\d+/, "number"], [/\b(true|false|null)\b/, "constant"],
      [/\b(on|task)\b/, { token: "keyword", next: "@handler" }], [/\b(sequence|loop|if|else|walk|say|narrate|take|show|hide|enable|disable|remove|replace|enter|set|wait|await|shake|spawn|face)\b/, "keyword.command"],
      [/\b(game|room|entity|inventory|trigger|action|fallback)\b(?=\.)/, "type.identifier"], [/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/, "variable.predefined"], [/[{}()]/, "@brackets"], [/[=!<>+\-*\/]+/, "operator"]
    ], handler: [[/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/, "type.identifier", "@pop"], [/[ \t]+/, "white"], [/$/, "", "@pop"]] }
  });
  monaco.languages.registerCompletionItemProvider("anachronist", { triggerCharacters: [".", " "], provideCompletionItems(model, position) {
    const index = indexes.get(model.uri.toString()) || emptyIndex;
    const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    let values: string[] = [], detail = "Anachronist project";
    if (/enter\s+room\s+\w*$/.test(prefix)) [values, detail] = [index.rooms, "Room ID"];
    else if (/\bat\s+\w*$/.test(prefix)) [values, detail] = [index.spawns, "Spawn ID"];
    else if (/\b(replace|remove|take)\s+\w*$/.test(prefix)) [values, detail] = [index.items, "Inventory item"];
    else if (/\b(set|if)\s+[\w.]*$/.test(prefix)) [values, detail] = [index.states, "State variable"];
    else if (/\bon\s+[\w.]*$/.test(prefix)) [values, detail] = [[...index.entities.flatMap(id => index.verbs.map(verb => `${id}.${verb}`)), ...index.verbs, "enter"], "Handler"];
    else values = [...index.entities, ...index.items, ...index.rooms, ...index.graphics, ...index.animations, ...index.protocol, ...index.states];
    const word = model.getWordUntilPosition(position), range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    return { suggestions: [...new Set(values)].map(label => ({ label, insertText: label, detail, kind: monaco.languages.CompletionItemKind.Reference, range })) };
  }});
  monaco.languages.register({ id: "anachronist-ini", extensions: [".ini"] });
  monaco.languages.setMonarchTokensProvider("anachronist-ini", { tokenizer: { root: [[/^[ \t]*[;#].*$/, "comment"], [/^\s*\[[^\]]+\]/, "type.identifier"], [/^[^=\n]+(?=\s*=)/, "attribute.name"], [/"(?:\\.|[^"\\])*"/, "string"], [/\b(true|false)\b/, "constant"], [/-?\d+(?:\.\d+)?/, "number"], [/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/, "number.hex"]] } });
}

export function setDiagnostics(monaco: typeof Monaco, model: Monaco.editor.ITextModel, diagnostics: any[]) {
  monaco.editor.setModelMarkers(model, "anachronist", diagnostics.map(diagnostic => ({
    severity: diagnostic.severity === "warning" ? monaco.MarkerSeverity.Warning : diagnostic.severity === "info" ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Error,
    message: diagnostic.message, code: diagnostic.code,
    startLineNumber: diagnostic.range?.start.line || diagnostic.line || 1, startColumn: diagnostic.range?.start.column || diagnostic.column || 1,
    endLineNumber: diagnostic.range?.end.line || diagnostic.line || 1, endColumn: Math.max((diagnostic.range?.end.column || diagnostic.column || 1), (diagnostic.range?.start.column || 1) + 1)
  })));
}
