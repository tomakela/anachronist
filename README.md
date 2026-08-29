# Anachronist

Anachronist is being designed as a portable point-and-click adventure engine. The
game is split into two deliberately independent parts:

1. a deterministic virtual machine that owns all game state and rules; and
2. a replaceable host that renders VM output and turns platform input into VM
   events.

The browser host will be the first implementation, but the protocol is intended
to support native hosts later. The design is specified in:

- [`vm.md`](vm.md) — VM responsibilities, data model, lifecycle, and host protocol;
- [`script_language.md`](script_language.md) — the portable adventure scripting
  language; and
- [`js_engine.md`](js_engine.md) — the HTML5/JavaScript host architecture.

All game-specific values and assets live below [`game/`](game/), including
graphics dimensions/animation metadata and the verb/inventory interface. The root
[`index.html`](index.html) is intentionally only a host boot document; it contains
no room, object, asset, resolution, palette, or interaction constants.

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
left-click destination redirects free walking immediately, right-click defaults
to **Look**, and either button advances displayed dialogue. Hovering an object
previews the complete command sentence, while starting an interaction interrupts
the current walk. Entity `position` values denote configurable sprite origins
(the center by default), letting walk targets line up naturally with feet or
knees. Taking and using objects also play directional one-shot animations.
Each room's mutable entity state is retained between visits, so a taken object
cannot reappear at its old room position when the player returns. The demo also
records key acquisition in the persistent `game.key_taken` global for its game
logic.
Room `player_scaling` perspective stops scale the actor according to its y
position, with linear interpolation between two or more `y,scale` pairs. Taking
the hall clock now runs a multi-step scene: it disappears from the wall, appears
fallen on the floor, and remains fallen after a round trip to the garden.
Rooms may also declare rectangular `[trigger.name]` regions. Crossing into one
dispatches `trigger.enter(name)`; a player spawned inside a region must leave it
before that region can fire, preventing immediate room-transition loops. The
demo's unlocked door uses this mechanism, can be opened and closed, and swaps
graphics with its state. Walking to the open door crosses its trigger and enters
the garden.

Graphics may declare `transparent_color = #RRGGBB`; matching pixels become
transparent after decoding. Room entities render back-to-front by their `depth`
value, or by their y position when depth is omitted, so the player can walk
behind foreground scenery. A room may also name a bitmap with `walk_mask`; only
its opaque, non-black pixels permit player movement (the mask is scaled to the
logical room size).

Verb sentence prepositions are package data (`preposition = at` makes the
**Look** action read “Look at …”, while `object_preposition = on` produces
“Use key on door”). **Use** accepts a room or inventory object first, waits for
a distinct target, and omits the first object from the available targets. A
ground item transaction can walk to and take that item before approaching its
target; an already inventoried item skips those obsolete steps. The complete
transaction is rejected before movement if any step is invalid. Two-object use
dispatches `entity.use_item`. Dialogue can
contain any number of consecutive `say` or
`narrate` commands; each is displayed in order, with its duration calculated
from the configurable base, per-character, and minimum tick values in
`game.ini`.
