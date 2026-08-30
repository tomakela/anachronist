# VM API and instruction reference

This document describes the **implemented** API in `engine/vm.js`. It is a
companion to [`vm.md`](vm.md), which describes the wider VM architecture, and
[`script_language.md`](script_language.md), which describes author-facing
Anachronist Script. `DeterministicVM` is the platform-neutral state machine;
[`Runtime`](engine/runtime.js) supplies its project state, handler lookup,
rendering, persistence, and browser adapters.

## Module exports

```js
import { DeterministicVM, prepareItemUse } from "./engine/vm.js";
```

### `prepareItemUse(commands, world, protocol)`

Validates and prepares a two-object Use transaction without changing `world`.

| Parameter | Required shape |
| --- | --- |
| `commands` | Array of command objects (see [Instruction objects](#instruction-objects)). |
| `world` | `{ inventory, entities, rooms, items? }`; `inventory` is an ID array and `entities`, `rooms`, and `items` are ID maps. |
| `protocol` | Must define `walk_command`, `take_command`, `player_actor`, and `use_animation`. |

The function simulates inventory membership and entity visibility in command
order. Redundant walks to or takes of an item already in inventory are removed.
It returns `null` if a referenced actor, visible target, inventory item,
replacement item, state owner, room, or spawn makes the transaction invalid.
Otherwise it returns a new command array with the configured player Use
animation inserted immediately after the final walk command. Unknown command
operations are retained for later execution.

**Throws:** `Error` when a required protocol field is absent.

> Validation is atomic, but the returned commands are not executed atomically:
> callers enqueue them and `step()` applies them over subsequent ticks.

### `class DeterministicVM`

The deterministic command and interaction core. The base class has no
constructor because the concrete runtime injects its state and collaborators.
At minimum, methods rely on the following groups of fields:

- package data: `game`, `ui`, `rooms`, `items`, `animations`, and `bitmaps`;
- state: `room`, `entities`, `roomEntities`, `roomState`, `globals`,
  `inventory`, `inventoryEntities`, `queue`, selection/message fields, and
  `tick`;
- movement/layout: `width`, `height`, `walkSpeed`, `fastWalkMultiplier`, and
  `inventoryRow`; and
- runtime collaborators: `handlers`, `backgroundTasks`, and inherited
  implementations such as `dispatch`, `commands`, `matchingHandler`,
  `scriptState`, `targetAt`, `inventoryLayout`, `label`, and queue helpers.

Use `Runtime` rather than constructing this base class directly unless the host
provides that complete contract.

## DeterministicVM methods

### Protocol and presentation

#### `protocolValue(name) -> string`

Returns `game.protocol[name]`. Throws `Error` if it is absent or falsy. Use this
instead of hard-coding package-specific command, actor, verb, or animation IDs.

#### `vmProtocol` (getter)

Returns `game.protocol` unchanged.

#### `phrase(name, values = {}) -> string`

Reads `ui.accessibility[name]` and replaces every `{key}` for each entry in
`values`. `null` and `undefined` substitutions become an empty string. Throws
when the phrase is not declared; undeclared placeholders remain in the result.

#### `sceneSnapshot() -> Readonly<object>`

Returns a detached, recursively frozen clone containing `room`, `entities`,
`inventory`, `inventoryEntities`, `queue`, message state, interaction selection,
`tick`, and `shakeTicks`. Mutating the snapshot throws or has no effect on live
VM state. Browser-only rendering state is intentionally excluded.

### Input and interaction

#### `action(event) -> void`

Routes a semantic host event. The currently supported shape is:

```js
{ type: "pointer", button?: 0 | 2, point: [x, y], fast?: boolean }
```

`button` defaults to primary (`0`). Coordinates are logical game coordinates.
Missing/non-string `type` raises `TypeError`; an unsupported type raises
`Error`.

#### `pointer({ button = 0, point, fast = false }) -> void`

Processes one logical pointer action. It handles, in order, cut-scene advance,
fast queue acceleration, inventory scrolling, verb selection, message
dismissal, target resolution, secondary-click suggested verbs, walking, direct
verbs, and two-object Use. Primary is `0`; secondary is `2`. Other button
values follow primary targeting behavior but cannot select a verb panel entry.

This method mutates selection state and queues commands; it does not advance a
tick. A point is required and is destructured as `[x, y]`.

#### `perform(verb, target) -> void`

Clears interruptible work, builds the action sentence, and enqueues the matching
`entity.<verb>` handler. The configured one-object Use verb also prepends its Use
animation. If no handler matches, the fallback chain is enqueued. A falsy
`target` is ignored.

#### `fallbackCommands(verb, args) -> Command[]`

Returns the first matching scripted fallback in this order:

1. current-room entity (`entity.fallback_<verb>`);
2. inventory item (`fallback.<verb>`);
3. current room (`fallback.<verb>`); then
4. package-level (`fallback.<verb>`).

If none exists, returns one `narrate` command made from
`ui[fallback.<verb>].text` or `ui.fallback.text`. Template substitutions are
`{verb}`, `{target}`, `{first}`, and `{second}`. Throws if no fallback text is
declared.

#### `enqueueFallback(verb, args) -> void`

Appends the result of `fallbackCommands()` to `queue`.

#### `advanceCutScene() -> void`

Advances exactly the active presentation phase: dismisses text, completes the
player animation, clears shake time, or delegates to the cut-scene queue
advancer. It does not skip ordered state changes.

### Rooms, time, and commands

#### `enter(id, spawn) -> void`

Changes to a declared room and spawn. It cancels tasks owned by the previous
room, resolves interaction/scaling/walk-mask state, restores or creates room
entities, grants first-entry inventory items, creates the configured player,
initializes trigger occupancy, and dispatches `room.enter`.

**Throws:** for an unknown room, missing spawn, invalid scaling/mask data,
missing player declarations, or required protocol fields. State is changed as
the method proceeds; this method itself is not rollback-safe.

#### `step() -> void | unknown`

Advances the logical clock by one tick and steps all background tasks. Shake,
message, and actor-animation timers have priority and consume the tick. The next
foreground command is then processed. Walk commands remain at the head of the
queue until their route completes or blocks; every other command is removed
before being passed to `execute()`.

Player walks use pathfinding, walk masks, vertical speed scaling, and the fast
multiplier. Non-player actors walk directly. Trigger entry is checked during
player motion.

#### `execute(command) -> void`

Applies one foreground instruction. See the complete operation table below.
Most invalid targets are ignored, but `hide`, `show`, and some `set` targets can
raise ordinary JavaScript errors. Callers should normally enqueue commands and
let `step()` execute them rather than invoking this directly.

#### `performBackground(command) -> void`

Applies the background-safe subset: `set`, `show`, `hide`, `face`, and `spawn`.
Missing entities are ignored. Any other operation throws `Error`; presentation,
inventory, movement, and room-transition commands therefore cannot run inside
a background task.

#### `updateTriggers(point) -> void`

Updates the set of triggers occupied by the player and dispatches
`trigger.enter` once for every newly entered trigger. Dispatch is suppressed
while an `enter` command is already queued.

## Instruction objects

Instructions are plain objects produced by script compilation and consumed in
queue order. IDs below are package-local strings; points are `[x, y]` logical
coordinates.

| `op` | Fields | Foreground behavior |
| --- | --- | --- |
| `walk` | `actor`; exactly one of `target` or `point`; optional `fast`, `manual` | Moves toward an entity position or point over ticks. For the player, calculates `route` lazily and observes walkability/triggers. Missing actors or destinations discard the command. |
| `enter` | `room`, `spawn` | Calls `enter(room, spawn)`. |
| `say` | `value`; optional `fast`, `skipPresentation` | Shows timed speech. `skipPresentation` suppresses it; `fast` makes it last one tick. |
| `narrate` | Same as `say` | Shows timed narration. |
| `animate` | `actor`, `animation`; optional `fast`, `skipPresentation` | Stops the actor walking and applies a directional animation for its declared duration. Missing actors are ignored. |
| `take` | `target`; internal `animated` | If visible and not held, first queues the configured pickup animation, then hides the entity and adds it to inventory. |
| `remove` | `target` | Removes an existing inventory item and its inventory entity. Missing items are ignored. |
| `replace` | `target`, `replacement` | Replaces a held item when the replacement is declared and not already held. |
| `show` / `hide` | `target` | Sets the room entity's string-valued `visible` field to `"true"` / `"false"`. |
| `set` | `target`, `value` | For `game.field`, writes a global; for `roomId.field`, writes room state; otherwise writes `String(value)` to an entity field. Only the first two dot-separated target parts are used. |
| `wait` | `ticks`; optional `fast`, `skippable`, `skipPresentation` | Prepends `ticks` pause commands (`1` when fast). Suppressed by `skipPresentation`. |
| `pause` | — | Consumes one tick with no state change. Normally generated by `wait`. |
| `shake` | `ticks`; optional `fast`, `skipPresentation` | Sets remaining shake ticks (`1` when fast). Suppressed by `skipPresentation`. |
| `spawn` | `definition`, `args`, optional `ownerRoom` | Starts a deterministic background task. |
| `face` | `actor`, `direction` | Changes the actor facing direction. |

### Parsed instructions with context restrictions

- `await N ticks` compiles to `op: "await"` and delays a background task. It has
  no foreground implementation and should only appear inside `task` bodies.
- `loop { ... }` is expanded as a repeatable task command. It has no foreground
  implementation and should only appear inside `task` bodies.
- `enable target` and `disable target` are accepted by the current parser but
  have no VM execution behavior. Do not rely on them; use `set` on an implemented
  state field instead.
- `sequence { ... }` and `if ... { ... } else { ... }` are compile-time control
  flow: instantiation flattens the chosen commands, so they never reach the VM.

Unknown operations passed to `execute()` currently have no effect. In contrast,
unknown operations passed to `performBackground()` are errors.

## Command flags and timing

| Flag | Meaning |
| --- | --- |
| `fast` | Reduces waits, messages, animations, and shake to one tick; multiplies player walk speed. |
| `skippable` | Marks commands emitted by a `skippable` handler for queue acceleration. |
| `skipPresentation` | Suppresses presentation-only work while preserving ordered state mutations. |
| `manual` | Identifies a pointer-requested walk for interaction queue behavior; movement execution is otherwise unchanged. |

One call to `step()` is one VM tick. Text duration comes from
`runtime.text_duration_ticks` or the configured base/per-character/minimum
formula. Animation duration is the sum of frame durations for the actor's
direction. Neither operation reads wall-clock time.

## State and error contract

- Entity `visible` values are currently the strings `"true"` and `"false"`.
- `sceneSnapshot()` is the supported detached state view; live maps and arrays
  remain mutable implementation details.
- Handler commands are instantiated from a snapshot-like script scope before
  queue execution. Subsequent commands can change live state, but do not
  retroactively change already-instantiated values.
- Package/configuration errors throw synchronously. The VM does not wrap them in
  host diagnostics at this layer.
- Determinism requires callers to submit semantic actions and call `step()` in a
  stable order. Do not call input methods concurrently or mutate live VM fields.

## Minimal host-side example

```js
// `runtime` is a fully initialized Runtime (or a complete DeterministicVM host).
runtime.action({ type: "pointer", button: 0, point: [120, 80] });
runtime.step();

const scene = runtime.sceneSnapshot();
console.log(scene.room, scene.tick);
```
