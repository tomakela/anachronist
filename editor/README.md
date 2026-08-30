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

Open the URL printed by Vite (normally `http://localhost:5173`). The editor loads
the repository-local `game/` package through Vite and is read-only. This path is
resolved relative to the editor configuration, not the directory where the command
was started.

The project service in `src/projectService.ts` owns open documents and exposes
open, read, edit/dirty tracking, save, save-all, external-change checking, and
guarded close/replace operations independently from the React views.
