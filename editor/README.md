# Anachronist Editor

The editor is a separate npm workspace so its React, TypeScript, and Vite toolchain
does not become a dependency of the browser runtime. It imports the production
INI parser and Anachronist compiler directly from `../engine/`; editor validation
therefore follows the same rules as the game.

Install the workspace dependencies and start Vite from the repository root:

```sh
npm install
npm run editor:dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). Do not serve the
`editor/` source directory directly with a static server such as
`python3 -m http.server`: browsers cannot execute the TypeScript/TSX entry point,
and a static server may send it as `text/plain`, causing a strict module MIME-type
error.

To use a static server, build the browser-ready files first and serve only the
generated directory:

```sh
npm run editor:build
python3 -m http.server 8000 --directory editor/dist
```

Then open `http://localhost:8000`. Use **Open folder** in a browser with the File
System Access API for read/write access. Other browsers fall back to a directory
upload; saves are delivered as replacement-file downloads because a directory
upload cannot grant write permission.

The project service in `src/projectService.ts` owns open documents and exposes
open, read, edit/dirty tracking, save, save-all, external-change checking, and
guarded close/replace operations independently from the React views.
