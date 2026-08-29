# Virtual machine architecture

## 1. Purpose and boundary

The adventure virtual machine (VM) is the authoritative game runtime. It owns
rooms, actors, objects, inventory, dialogue, variables, timers, animation intent,
audio intent, save data, and the consequences of input. A host (initially the
JavaScript engine) owns only platform services: file loading, a display surface,
audio devices, clocks, pointer/touch/keyboard collection, storage, and
accessibility presentation.

This division is a portability rule, not merely an implementation detail. Given
the same game package, initial save, ordered input events, and logical clock
ticks, every conforming host must produce the same VM state and command stream.

The host must never contain:

- room identifiers, walkable areas, hotspots, dialogue, inventory rules, or
  puzzle logic;
- asset paths, sprite dimensions, animation rates, palettes, fonts, cursors, or
  sound mappings;
- a fixed resolution, color depth, coordinate scale, input binding, save-slot
  count, timing rate, or text speed; or
- fallbacks that silently invent missing game data.

When required package data is absent or invalid, loading fails with a structured
diagnostic. This makes accidental hard-coding visible.

## 2. Package layout

The package entry point is `game/game.ini`. Paths are package-relative, use `/`,
and may not escape `game/`.

```text
game/
  game.ini                 package and display configuration
  main.ana                 package-wide initialization
  resources/
    index.ini              logical resource catalogue
    ...                    images, palettes, fonts, audio, and text
  rooms/
    index.ini              room catalogue
    foyer/
      room.ini             room data
      script.ana           implicitly foyer-owned handlers
```

Catalogue files assign stable logical IDs. Scripts refer to `hero.walk.east` or
`room.foyer.background`, never filenames. Hosts resolve neither IDs nor paths on
their own; the VM validates catalogues and emits resolved resource handles.

Unknown INI keys are errors for the declared format version. Optional values and
defaults belong to the versioned specification, never to a host implementation.

## 3. Configuration

`game.ini` uses UTF-8, case-sensitive identifiers, `;` comments, and
`key = value` entries. Its sections have these responsibilities:

| Section | Required information |
| --- | --- |
| `package` | package ID, package format version, start script, resource and room catalogues, graphics metadata, and interface declaration |
| `display` | logical width/height, bit depth, scaling filter, aspect policy, orientation policy |
| `runtime` | VM tick rate, language, deterministic random seed policy |
| `input` | action names and bindings or the path to a binding map |
| `save` | save format version and game-declared slot policy |

The supplied planning configuration defines a 320×200 logical display. Bit
depth, like every other display property, is explicit there and can be changed by
game authors without altering a host.

Configuration is loaded in this order:

1. parse and validate `game.ini` without applying host defaults;
2. load catalogues and verify unique IDs and safe paths;
3. compile the package entry script, then load room metadata and compile each
   room script in deterministic room-catalogue order;
4. ask the host whether it supports the requested capabilities; and
5. either start atomically or return all validation errors.

### 3.1 Graphics catalogue

Every bitmap entry in the graphics definition may declare `width` and `height`
in logical pixels. When either value is absent, that dimension defaults to the
decoded bitmap dimension; this is the only graphics-size default and is applied
by the VM after decoding metadata. A declared dimension must be a positive
integer. Draw commands always carry the resolved dimensions, so a failed image
load cannot change layout.

An optional graphic may declare a unique `missing_color`. If its bytes cannot be
loaded or decoded, the VM emits a solid rectangle at every requested draw
position using the graphic's resolved width, height, transform, and clipping.
Thus the substitute has exactly the same shape as the missing graphic. Colors
must be distinct among entries in one catalogue, allowing each missing object to
be identified visually. Missing required graphics remain fatal errors.

A sprite entry may declare `frames` as an ordered list of source rectangles and
per-frame durations in VM ticks. Durations are positive integers and may differ
from frame to frame. The VM advances frames on logical ticks, includes the
selected source rectangle and resolved destination size in snapshots, and emits
`animation.done` after the last frame for non-looping animations.

### 3.2 Adventure interface

The package interface declaration defines a lower-left verb panel containing,
in order, `look`, `use`, `take`, `open`, `close`, and `talk`. The inventory panel
occupies the region immediately to the right of the verbs. Layout is resolved in
logical display coordinates and published as part of the scene/focus model, so
hosts do not recreate or reposition it independently.

Selecting a verb makes it the active interaction until it is consumed, changed,
or cancelled. When no verb is active, pointer activation in a room dispatches
the built-in `walk` action. `walk` is therefore the declared default rather than
a host-side fallback; actionable accessibility nodes expose the same verb and
inventory ordering.

## 4. VM data model

### 4.1 Values

Scripts use `null`, booleans, signed integers, fixed-point numbers, strings,
lists, maps, entity references, resource references, room references, vectors,
and colors. Fixed-point arithmetic is used for game simulation so results do not
vary with a host's floating-point behavior. Render coordinates are logical
display coordinates.

### 4.2 Entities and components

Every actor, prop, hotspot, inventory item, and transient effect is an entity
with a package-stable ID. Declarative components describe it:

- `transform`: room, position, depth, parent, visibility;
- `visual`: resource/animation, frame, tint, opacity;
- `interaction`: verbs (including look, use, take, open, close, and talk), hit shape, priority, enabled state;
- `movement`: walk speed, path, facing, walk-region constraints;
- `inventory`: icon, quantity, combinations;
- `audio`: cue and spatial parameters; and
- `script`: event handlers and serializable local state.

Components and component fields are schema-versioned. The VM rejects fields it
cannot interpret rather than leaving their meaning to a host.

### 4.3 Rooms

A room file declares its logical size, background layers, camera rules, regions,
walkable polygons, portals, entities, ambient cues, and script module. Room
loading is a VM transaction: old-room exit handlers run, declared resources are
preloaded, new state is created, entry handlers run, then one complete scene is
published. Failed loads do not expose half-created state.

### 4.4 State ownership

State is divided into package globals, room state, entity/component state,
coroutines, timers, and engine bookkeeping. Render and audio commands are not
state. A host cannot mutate state directly; it can only submit protocol events.

## 5. Execution model

The VM is single-threaded and event-driven. Each logical tick performs:

1. accept the next ordered batch of host events;
2. normalize events against the current scene and input configuration;
3. resume eligible timers and coroutines;
4. dispatch handlers in documented priority and registration order;
5. commit queued state changes;
6. derive an immutable scene snapshot plus audio/UI commands; and
7. expose save checkpoints only after the commit.

Handlers run to a configurable instruction budget. A budget overrun yields a
diagnostic and suspends the offending handler; it never freezes the host. Script
coroutines may explicitly wait for ticks, animation completion, movement,
dialogue choice, or a named event. Wall-clock time is never observable by game
logic unless delivered as an explicitly nondeterministic capability.

Event ordering for equal ticks is: lifecycle, resource results, timer wakes,
animation/movement completions, user actions, then script-emitted events. Within
a class, the host-provided sequence number is used. Newly emitted events are
queued, not recursively dispatched.

## 6. Host protocol

The transport may be direct function calls, worker messages, or a native FFI,
but messages use the same versioned, serializable shapes.

### Host to VM

- `boot(configText, packageBase, hostCapabilities)`
- `resourceResult(requestId, status, bytesOrError)`
- `tick(tickNumber)`
- `pointer(action, pointerId, logicalPosition, sequence)`
- `action(actionId, phase, value, sequence)`
- `viewportChanged(viewportInfo)` (presentation only)
- `saveRequested(slotId)` / `loadRequested(slotId, bytes)`
- `audioFinished(instanceId)` and `visibilityChanged(state)`

Raw DOM events and physical pixels never cross this boundary. The host converts
coordinates by the VM-published viewport transform. Input outside the active
logical viewport is tagged `outside`, not clamped.

### VM to host

- resource requests with media type, integrity metadata, and logical purpose;
- a scene snapshot containing ordered draw primitives in logical coordinates;
- cursor, subtitle, dialogue-choice, and focus-model descriptions;
- play/stop/fade audio commands with VM-issued instance IDs;
- save bytes and metadata;
- preload progress; and
- structured diagnostics with severity, source span, and stable code.

The command schema must not assume Canvas, WebGL, DOM, browser codecs, or a file
system. Capability negotiation occurs before execution. Unsupported required
capabilities are a load error; optional degradation must be declared by the game
package.

## 7. Rendering contract

The VM publishes logical pixels and ordered primitives: bitmap blits, animation
frames, rectangles, text runs using declared bitmap fonts, and palette effects.
Layer and depth order are fully resolved by the VM. The host may batch commands
but may not reorder them or reinterpret collision and hotspot geometry.

The game configuration determines logical resolution, color model/bit depth,
palette behavior, transparency key, aspect handling, and scaling filter. For
pixel-art packages the configured `nearest` filter must be honored at every
scaling stage. If a host cannot honor a required render mode, it must reject the
package clearly.

## 8. Persistence and compatibility

Saves are VM-produced, versioned binary envelopes containing package ID/version,
save schema version, deterministic state, VM version, checksum, and optional
game-authored metadata. They never contain DOM state, decoded browser objects,
URLs, or renderer caches. The host treats save bytes as opaque.

Package scripts may declare stepwise save migrations. Loading validates identity
and checksum, migrates into a temporary state, validates references, then swaps
state atomically. Forward-incompatible saves remain untouched and receive a
diagnostic.

## 9. Security and limits

Scripts have no filesystem, network, DOM, dynamic-code, or host-language access.
The VM enforces package-root path containment, resource size limits, collection
limits, recursion/instruction limits, and bounded event queues. Limits are
capabilities negotiated from package requirements; hosts do not silently choose
gameplay-altering values.

## 10. Portability acceptance criteria

A conforming VM/host pair must pass replay fixtures that compare committed state
hashes and command streams across hosts. The same fixture must cover pointer and
touch actions, room transitions, dialogue, inventory, save/load, and missing
capabilities. A new platform host is acceptable only when it can run these
fixtures without platform-specific changes to `game/`.
