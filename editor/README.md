# Anachronist Editor

The editor is a separate npm workspace so its React, TypeScript, and Vite toolchain
does not become a dependency of the browser runtime. It imports the production
INI parser and Anachronist compiler directly from `../engine/`; editor validation
therefore follows the same rules as the game.

Run `npm run editor:dev` from the repository root. Use **Open folder** in a browser
with the File System Access API for read/write access. Other browsers fall back to
a directory upload; saves are delivered as replacement-file downloads because a
directory upload cannot grant write permission.

The project service in `src/projectService.ts` owns open documents and exposes
open, read, edit/dirty tracking, save, save-all, external-change checking, and
guarded close/replace operations independently from the React views.
