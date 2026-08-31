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

## Native desktop editor (Tauri 2)

The `src-tauri/` crate wraps the same Vite application in Tauri 2. The native
shell adds a folder picker and direct, writable access to the selected game
directory; project paths are validated by the Rust backend before files are
read or saved.

### Prerequisites

Install Node.js 20 or newer, Rust's stable toolchain, and the platform packages
required by Tauri 2. In particular, Linux builds need WebKitGTK and the other
distribution packages listed in the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/);
Windows builds require Microsoft C++ Build Tools and WebView2, and macOS builds
require Xcode command-line tools. Build installers on the operating system they
target—Tauri does not generally cross-compile desktop bundles.

From the repository root, install JavaScript dependencies once:

```sh
npm install
```

Start a native development window with live frontend reload:

```sh
npm run tauri:dev
```

The folder chooser shown at startup selects the game package directory (for
this repository, choose `game/`). Use **Open project** to switch directories.

Create an optimized application and platform installer with:

```sh
npm run tauri:build
```

Tauri writes Rust build output under `editor/src-tauri/target/release/` and
installable packages under `editor/src-tauri/target/release/bundle/`. To compile
only the web frontend, continue to use `npm run editor:build`.
