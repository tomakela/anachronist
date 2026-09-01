# Anachronist

Anachronist is being designed as a portable point-and-click adventure engine. The
game is split into two deliberately independent parts:

1. a deterministic virtual machine that owns all game state and rules; and
2. a replaceable host that renders VM output and turns platform input into VM
   events.

The browser host will be the first implementation, but the protocol is intended
to support native hosts later. The design is specified in:

- [`vm.md`](vm.md) — VM responsibilities, data model, lifecycle, and host protocol;
- [`vm_api.md`](vm_api.md) — implemented VM functions, methods, command objects,
  and execution semantics;
- [`script_language.md`](script_language.md) — the portable adventure scripting
  language; and
- [`js_engine.md`](js_engine.md) — the HTML5/JavaScript host architecture.

All game-specific values and assets live below [`game/`](game/), including
graphics dimensions/animation metadata and the verb/inventory interface. The root
[`index.html`](index.html) is intentionally only a host boot document; it contains
no room, object, asset, resolution, palette, or interaction constants.

The package entry script is `game/main.ana`. Variables declared before the first
INI section become persistent `game.name` or `room_id.name` values, and every
room namespace is initialized at startup. Each room has a directory containing
`room.ini` data and an implicitly room-owned `script.ana`. The catalogue order is
also the deterministic handler merge order. Scripts end simple statements at a
newline or closing brace, reject semicolons, have no `module` declaration, and
support room-local forms such as `on enter()` and `on door.open()`.

## Running the demo

Serve the repository over HTTP (for example, `python3 -m http.server 8000`) and
open `http://localhost:8000`. The JavaScript host parses package INI files and
Anachronist Script, renders the configured bitmap catalogue on one full-screen
pixel-scaled canvas, and runs a two-room key-and-door demo. All visible
dimensions, colors, labels, timings, animations, and object placements come from
files below `game/`. Bitmap placeholders are stored as text-encoded assets so the
complete game package remains portable through text-only source systems. Select
**Use**, the key, and the door to exercise an atomic
scripted `walk → take → walk → unlock → room change` command chain. A new
left-click destination redirects free walking immediately, right-click (or long touch) uses that object's `suggested_verb`, defaulting
to **Look**. Room entities declare it in `room.ini`, and inventory objects in
`inventory.ini`; hovering an object subtly highlights its suggested verb. Either
button advances displayed dialogue. Hovering an object previews the complete command sentence, while starting an interaction interrupts
the current walk. Entity `position` values denote configurable sprite origins
(the center by default), letting walk targets line up naturally with feet or
knees. Taking and using objects also play directional one-shot animations.
Each room's mutable entity state is retained between visits, so a taken object
cannot reappear at its old room position when the player returns. The demo also
records key acquisition in the persistent `game.key_taken` global for its game
logic. The supplied inventory now forms a set of small puzzles: coffee coaxes a
stick from the dry bush, the pencil writes in the notebook, the handkerchief
cleans the fallen clock, and that clock can prop open the unlocked door. In the
garden, the coin can be thrown into the fountain and the key can bridge a broken
wire. The lamp's switch button is missing, so its newly powered mechanism can
only be toggled by using the stick on it. These puzzle changes persist across
room visits.

### Current graphics and interface dimensions

All dimensions below are **logical pixels**. The demo renders at 320×200 and
the host scales that canvas to the available screen with nearest-neighbor
sampling, so asset authors should work at these logical sizes rather than at a
particular browser-window size. A room background image may have any source
dimensions because it is stretched to the full 320×200 display; 320×200 is the
recommended size when a background should map one source pixel to one logical
pixel. The current rooms use flat `background_color` values instead of images.

The lower 64 pixels are the interface: the command sentence occupies
320×16 at `(0,136)`, and the controls occupy `y = 152–199`. The six verb buttons
are each 40×24 in a 3×2 grid. Inventory begins at `(120,152)`, displays four
40×48 item slots per row, and reserves the rightmost 16×48 area for its two
scroll arrows. The 320×16 message region at the top of the display overlays the
room rather than reducing its size. Speech boxes are 14 pixels high, with their
width fitted to the text.

Current bitmap and sprite sizes are:

| Artwork | Logical render/frame size | Source bitmap or sheet size |
| --- | ---: | ---: |
| Room background | 320×200 (stretched) | 320×200 recommended |
| Player | 16×32 | 32×256 (two columns and eight directional rows) |
| Inventory item | 40×48 | 40×48 |
| Door / open door | 32×64 | 32×64 |
| Gate | 28×74 | 28×74 |
| Fountain / splash | 52×50 | 52×50 |
| Clock | 24×24 | 72×24 (three animation frames) |
| Key | 12×8 | 12×8 |
| Bush | 42×30 | 42×30 |
| Stick | 28×8 | 28×8 |
| Broken / fixed wire | 30×12 | 30×12 |
| Lamp off / on | 18×34 | 18×34 |
| Title | 216×35 | 216×35 |
| Title subtitle | 153×14 | 153×14 |

The coffee cup, coin, notebook, pencil, and handkerchief room placeholders are
also currently 40×48. Catalogue `width` and `height` values are logical render
dimensions; an entity's `size` can override them. Animation `frames` are source
rectangles within a sheet, so the sheet itself may be larger than the rendered
sprite. The authoritative values live in `game/game.ini` (display),
`game/interface.ini` (UI), `game/resources/graphics.ini` and
`game/resources/player.ini` (artwork), and each room's `room.ini` (entity
overrides and placement).

On touch-oriented devices, a relative drag cursor is enabled by default. A small
settings button in the top-right switches between it and direct pointing. Relative movement is
amplified by the package's `input.dragging_sensitivity` value, making precise
pointing possible without covering the target. A long touch performs the same suggested action as a desktop right-click. Small finger movements within the
configured `input.long_touch_move_tolerance` do not cancel a long touch. The
verb and inventory panels are UI only: touching their unused space never starts
walking or displays “Walk to”.
Room `player_scaling` perspective stops scale the actor according to its y
position, with linear interpolation between two or more `y,scale` pairs. Using
the same format, optional `player_walk_speed_scaling` stops independently scale
walking speed by y-position; this lets distant actors move more slowly without
forcing speed to follow the more dramatic visual scale. Taking
the hall clock now runs a multi-step scene: it disappears from the wall, shakes
the screen as it falls to the floor, and remains fallen after a round trip to
the garden. Scripts start the effect with `shake N ticks;`, while the game
package controls its logical-pixel amplitude.
Rooms may also declare rectangular `[trigger.name]` regions. Crossing into one
dispatches `trigger.enter(name)`; a player spawned inside a region must leave it
before that region can fire, preventing immediate room-transition loops. The
demo's unlocked door uses this mechanism, can be opened and closed, and swaps
graphics with its state. Walking to the open door crosses its trigger and enters
the garden.

Graphics may declare `transparent_color = #RRGGBB`; matching pixels become
transparent after decoding. Room entities render back-to-front by their `z`
value, from smallest to largest. The background is at z -100, ordinary objects
default to z 0, and the player defaults to z 100. An entity can instead set
`z_clip = Y` to switch around the player: when the player is above Y the object
is drawn first, and when the player is below Y the player is drawn first. Set `interactive = false` on
decorative entities that should be drawn but ignored by pointing and verbs. A
room may also name a bitmap with `walk_mask`; only
its opaque, non-black pixels permit player movement (the mask is scaled to the
logical room size). Player walks find a route around masked-out pixels. Clicking
outside the walkable area instead routes to its closest reachable point.
Whenever an item is picked up, the inventory automatically moves to its
last row so the new item is visible. Items granted together when entering a room
do not advance the inventory, so a starting inventory is shown from the first
row.

Entity pointing normally uses those sprite bounds. Authors can replace that
fallback with an absolute room-space `hotspot_rect = x,y,width,height` or
`hotspot_polygon = x,y; x,y; x,y` (three or more points). Set
`alpha_hit_test = true` to ignore transparent pixels when using sprite bounds;
the transparent-color-processed bitmap pixels are cached, and animated actors
use their current frame. Higher `hotspot_priority` values deliberately win an
overlap, with visual render order deciding equal priorities. For authoring, set
`hotspot_overlay = true` in `[room]` (or `[runtime]`) to draw labeled cyan
hotspot outlines.

A room can set `background_image` to a graphic catalogue ID to stretch that
bitmap across the logical display behind every entity. `background_color`
remains the fallback and fills any edges exposed by screen shake. All bitmap
decoding, processing, sprite/background drawing, and final canvas scaling use
nearest-neighbor sampling; the HTML settings controls are not part of that
pixel-art canvas pipeline.

Verb sentence prepositions are package data (`preposition = at` makes the
**Look** action read “Look at …”, while `object_preposition = on` produces
“Use key on door”). **Use** normally accepts a room or inventory object first,
waits for a distinct target, and omits the first object from the available
targets. An explicit single-object handler such as `on lever.use()` or
`on inventory.notebook.use()` overrides that behavior and runs immediately
when its object is selected, including when Use is the object's suggested verb.
Otherwise, a ground item transaction can walk to and take that item before
approaching its target; an already inventoried item skips those obsolete steps.
The complete transaction is rejected before movement if any step is invalid.
Two-object use dispatches `entity.use_item`; single-object use dispatches the
separate `entity.use` event. Inventory presentation is defined independently
from room entities in
`game/items/inventory.ini`; its `graphic` and `label` always win after pickup.
Inventory-only handlers use explicit names such as `on inventory.key.look()`, so
a room can separately define `on key.look()` for the key lying on the floor. The
demo begins with two non-interactive, full-display bitmap title cut scenes: the
game title, followed by an island establishing shot. The game title remains
visible for two seconds and the establishing shot for three seconds unless
advanced with a click, after which the hall restores the verb and inventory
interface. Dialogue can
contain any number of consecutive `say` or
`narrate` commands; each is displayed in order, with its duration calculated
from the configurable base, per-character, and minimum tick values in
`game.ini`.

### Debug configuration and scripts

Add `?debug` to the game URL to enable debug mode (other query parameters are
preserved when it is toggled from the **Game settings** cog). In this mode the
host optionally loads `debug.ini` beside the package entry file—for the default
`game/game.ini`, this is `game/debug.ini`. Its top-level variables and individual
section keys override `game.ini`; variables and section keys it does not mention
remain unchanged, and entirely new sections are allowed.

Each catalogued room also implicitly gets an optional `debug.ana` beside its
`room.ini`; no room-catalogue entry is needed. The normal `script.ana` is compiled
first and `debug.ana` second with the same room ownership and entity context, so
handler order remains deterministic. A missing `debug.ini` or room `debug.ana`
(HTTP 404) is ignored. Invalid INI/script contents, network failures, and every
other HTTP error still stop startup and are reported normally.
## Framework-neutral engine API

`engine/project.js` exports `loadProject(entryPath, adapters)` for package discovery,
INI parsing, script compilation, catalogue resolution, and asset loading without a
DOM dependency. Adapters provide `loadText(path, { optional })` and optionally
`loadAssets(graphics, resourceBase)`. The returned project includes configuration,
UI and input data, room and inventory catalogues and definitions, graphics and
animation metadata, decoded bitmaps, compiled handlers, and diagnostics.

Editors can call `validateProject` to run the same parser, compiler, and loading
pipeline used at game startup. `engine/runtime.js` separately exports `Runtime`;
construct it with the loaded project and explicit `host` and `storage` adapters,
plus optional `clock`, `scheduler`, and `initialRoom` values. The browser-specific
fetch and DOM wiring remains in the thin `engine/bootstrap.js` entry point.

## Editor

The React editor can run in a browser or as a native Tauri 2 desktop
application. See [`editor/README.md`](editor/README.md) for prerequisites and
the development and release build commands.
