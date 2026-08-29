# HTML5/JavaScript host architecture

## 1. Responsibilities

The JavaScript engine is a host adapter for the VM. It bootstraps from the game
entry named by `index.html`, fetches package files requested by the VM, presents
the VM's scene, captures platform input, plays requested audio, and stores opaque
saves. It does not implement game rules or interpret room/resource files beyond
transporting bytes to the VM.

The initial implementation should use ES modules and browser standards without
requiring a framework. The VM should run in a Web Worker when supported so
rendering and input remain responsive. A direct in-page transport may exist for
compatibility, but must use the identical message protocol.

## 2. Bootstrap sequence

1. `index.html` exposes only an accessible host root and a package-entry URL.
2. A small bootstrap module reads that URL; no game path is embedded in compiled
   JavaScript.
3. The loader fetches the entry as bytes/text and starts the VM protocol.
4. The VM validates configuration and requests catalogues/resources.
5. The host probes display, audio, input, storage, and worker capabilities and
   returns a capability document.
6. After successful negotiation, the VM publishes the initial scene and input
   model; only then is the loading UI replaced.

Every failure produces a visible, accessible diagnostic and console details.
Missing game values are not replaced with JavaScript defaults. The VM-defined
bitmap-dimension default and missing-graphic rectangles are package semantics,
not host guesses.

## 3. Modules

Suggested host-only modules are:

| Module | Role |
| --- | --- |
| `bootstrap` | discover entry metadata and wire services |
| `transport` | versioned VM messages, worker/direct implementations |
| `loader` | fetch, integrity checks, URL containment, decoded-asset cache |
| `renderer` | execute immutable scene snapshots |
| `viewport` | logical-to-CSS/device transform and resize observation |
| `input` | normalize pointer, touch, keyboard, and gamepad into declared actions |
| `audio` | unlock audio from a gesture and execute VM audio commands |
| `storage` | persist opaque saves and preferences under package identity |
| `accessibility` | mirror VM focus labels, dialogue, subtitles, and controls |
| `diagnostics` | loading progress and structured errors |

None may import game-specific modules. Dependencies point toward protocol types,
never from the VM toward DOM/browser code.

## 4. Rendering and pixel integrity

The logical framebuffer size and bit depth come from `game.ini`. The renderer
creates internal surfaces at that exact logical size. CSS/device sizing is a
separate presentation transform.

For a package requesting `nearest`:

- disable interpolation on Canvas 2D contexts before every scaled draw;
- apply CSS `image-rendering: pixelated` (and a standards-compatible fallback
  strategy where necessary);
- prefer the largest integer scale that fits while preserving aspect ratio;
- letterbox remaining space rather than stretching; and
- map input through the inverse of the exact render transform.

Fractional scaling may be needed on small screens. The host still uses nearest
sampling and stable edge calculations so adjacent logical pixels do not develop
gaps. The game-declared aspect policy decides whether cropping, letterboxing, or
fractional fit is permitted. A resize does not change the logical simulation.

The first renderer may use Canvas 2D. Renderer selection is capability-based;
WebGL/WebGPU renderers must produce protocol-equivalent output and cannot expose
their APIs to scripts.

Bitmap and sprite commands include resolved destination dimensions. If the VM
marks an optional graphic as missing, the renderer draws the supplied solid
color rectangle through the same transform and clip used by the bitmap. It must
not inspect a failed URL to choose dimensions or colors. Sprite source frames
and their tick-based, potentially non-uniform durations are resolved by the VM;
the host never advances animation from wall-clock time.

## 5. Desktop and mobile layout

The host root occupies the available visual viewport while respecting safe-area
insets. It observes element and visual-viewport changes rather than assuming a
screen size. It supports portrait/landscape changes according to the package's
orientation policy, fullscreen as a user action, and browser zoom.

Mobile behavior includes:

- Pointer Events as the unified path where available, with stable pointer IDs;
- `touch-action` derived from the declared gesture policy, not globally disabled;
- cancellation on `pointercancel`, lost capture, visibility changes, and VM
  scene replacement;
- no hover-only required action;
- controls sized/positioned from game UI declarations and accessibility needs;
- safe handling of the on-screen keyboard; and
- audio startup deferred until a user gesture when the browser requires it.

The current canvas host offers direct-touch and relative drag-cursor pointing
modes from a compact top-right settings control. Drag movement is multiplied by
the positive package value `input.dragging_sensitivity`; long touch maps to the
same semantic behavior as a secondary mouse click.

Desktop behavior includes mouse buttons, keyboard actions, optional gamepad
mapping, focus restoration, and context-menu policy. Bindings are declared by
the package; the host only converts physical input into declared action IDs.

For the supplied interface, the host renders the VM-published verb controls in
the lower-left and inventory immediately to their right. With no selected verb,
room clicks arrive as the VM-declared `walk` action. The DOM accessibility mirror
uses the identical order and active-verb state.

## 6. Input pipeline

DOM events are timestamped and sequenced immediately, then normalized at the
next VM tick. The viewport module converts client coordinates to fixed-point
logical coordinates and reports whether they are inside the active image.

Pointer capture preserves drags. Coalesced moves may be used for presentation,
but gameplay receives the deterministic sample policy declared in configuration.
Keyboard matching uses `code` or `key` as declared and ignores composition text
unless a VM text-input request is active. Browser-reserved shortcuts are not
captured. Synthetic mouse events following touch must be deduplicated.

The VM returns the cursor and focus model. The host renders the declared game
cursor while maintaining an accessible DOM focus representation for dialogue,
menus, and actionable hotspots.

## 7. Assets, audio, and loading

The loader accepts only VM requests rooted in the package base. It validates
status, declared media type, optional byte length, and integrity hash before
decoding. Logical IDs, filenames, sprite slicing, animation metadata, and preload
groups remain package/VM concerns.

Decoded resources are cached by content identity and released on VM instruction
or memory pressure. Loss must be transparent: the host requests/redecodes the
same bytes without changing state. A failed required asset is fatal; behavior for
an optional asset is specified by package data.

Audio commands use logical buses and game-declared gains. Browser autoplay
restrictions result in a `blocked` capability/state message, not skipped game
logic. Completion is reported with the VM's instance ID. The host must not infer
timing from file extensions or hard-code music/speech behavior.

## 8. Saves and preferences

IndexedDB is the preferred browser store, behind a storage adapter. Keys include
package identity and save schema; values are opaque VM bytes plus VM-provided
metadata. Storage quota and errors are protocol results. Export/import may wrap
the same bytes without interpreting them.

Host preferences such as fullscreen permission or accessible volume can be
separate from game saves, but they must not alter deterministic game state.
Game-defined settings travel through VM events and state.

## 9. Accessibility

The VM scene includes labels, roles, focus order, live text, subtitles, dialogue
choices, and actionable bounds. The host mirrors these into semantic HTML while
the canvas remains visual. DOM controls send ordinary action events; they never
mutate the game. Keyboard-only operation, screen-reader announcements, reduced
motion, contrast preferences, and captioning are negotiated capabilities.

Alternative behavior is only enabled when declared by game data. For example,
reduced animation may select a game-authored animation variant rather than a host
silently changing puzzle timing.

## 10. Security and deployment

Use a restrictive Content Security Policy compatible with static deployment:
same-origin packaged assets, no inline script, no `eval`, and explicitly scoped
workers/audio/images. Treat packages and saves as untrusted input. Validate
message schemas on both sides, contain paths, cap decoded dimensions and message
sizes, and never inject game text as HTML.

Service-worker/offline support is optional host infrastructure. Cache manifests
must be generated from package catalogues; a JavaScript source list must never
become a second asset manifest.

## 11. Testing and acceptance

- protocol contract tests replay the same event fixtures against worker and
  direct transports;
- golden images verify draw order, palettes, transparency, letterboxing,
  same-size missing-graphic rectangles with distinct colors, animated sprite
  timing, and nearest-neighbor scaling at integer and fractional viewport sizes;
- coordinate tests round-trip every viewport edge and outside point;
- browser tests cover mouse, touch, keyboard, cancellation, rotation, resize,
  lost focus, audio blocking, and storage failure;
- accessibility tests cover focus order, names, dialogue announcements, and
  keyboard-only play; and
- a lint/build rule rejects game asset IDs, filenames, or gameplay constants in
  host modules.

Target browser versions and the exact fallback matrix remain a product decision
and should be recorded before implementation rather than guessed here.
