# Anachronist scripting language

The custom language is provisionally named **Anachronist Script** and uses the
`.ana` extension. This document defines the planned portable surface; exact
visual content and game-specific declarations will be added later.

## 1. Design goals

- readable, small, and purpose-built for adventure events;
- deterministic and identical on browser and future native VMs;
- statically validated references to entities, rooms, resources, actions, and
  handler signatures;
- safe suspension for movement, animation, dialogue, and timers;
- serializable execution state so saves can include suspended scenes; and
- no implicit access to platform APIs or undeclared game data.

Source is UTF-8. Blocks use braces, statements end with semicolons, `//` starts a
line comment, and identifiers are case-sensitive. Formatting has no semantic
meaning.

## 2. Modules and declarations

```ana
module game.main;

import room foyer;
import resource hero_idle;

state game {
    bool introduction_seen = false;
    int score = 0;
}

on game.start() {
    enter room foyer at foyer.spawn.entry;
}
```

Imports are logical catalogue references, not paths. A compiler resolves and
type-checks them when the package loads. Top-level declarations are `module`,
`import`, `const`, `state`, `fn`, `event`, and `on`.

State must be explicitly scoped as `game`, `room`, or `entity`. Ordinary local
variables use `let` and disappear when their call finishes unless captured by a
serializable suspended coroutine.

## 3. Types and expressions

Primitive types are `bool`, `int`, `fixed`, `string`, and `null`. Domain types
include `room`, `entity`, `resource`, `action`, `vec2`, and `color`. Compound
types are `list<T>`, `map<K,V>`, and `option<T>`. There is no unbounded implicit
numeric conversion; conversions are named and checked.

Supported expressions include literals, typed references, field/index access,
function calls, unary operators, arithmetic, comparisons, boolean operators,
null coalescing, and list/map construction. Evaluation order is left to right.
Integer overflow, division by zero, invalid indexing, and missing required map
keys are runtime faults with source locations; they do not inherit JavaScript
behavior.

`fixed` has a VM-specified representation and rounding mode. Source decimals
compile exactly when representable and otherwise require an explicit rounding
function. Randomness comes only from the deterministic `random` service seeded
according to `game.ini`.

## 4. Control flow and functions

The language provides `if`/`else`, `match`, `while`, `for item in collection`,
`break`, `continue`, `return`, and `emit`. Functions declare argument and return
types and are pure unless marked `task` or they explicitly receive a mutable
state capability.

```ana
fn can_open(entity door) -> bool {
    return inventory.contains(item.brass_key) && door.enabled;
}

task open_door(entity door) {
    set door.interaction.enabled = false;
    play door visual.anim.open once;
    await animation door;
    set door.visual.frame = door.visual.anim.open.last_frame;
}
```

`set` is the visible state-mutation operation. Mutations are queued until the
handler transaction commits. A fault rolls back that handler's mutations and
commands.

## 5. Events and handlers

The standard event families are:

- lifecycle: `game.start`, `game.resume`, `room.enter`, `room.exit`;
- interaction: `entity.look`, `entity.use`, `entity.talk`,
  `entity.use_item`, and game-defined verb events;
- input actions: `action.press`, `action.release`, and `action.change`;
- movement/visual: `movement.done`, `animation.done`;
- conversation: `dialogue.choice`, `dialogue.done`;
- inventory: `inventory.added`, `inventory.removed`;
- timing: `timer`; and
- game-defined typed events.

```ana
on entity.look(target: entity.faded_portrait) {
    say actor.player text.portrait_description;
}

on entity.use_item(
    target: entity.locked_door,
    item: item.brass_key
) when target.interaction.enabled {
    remove item from inventory;
    await open_door(target);
    emit puzzle.unlocked(target);
}
```

Handlers may have a `when` guard and an explicit priority. Equal-priority
handlers run in declaration order. The compiler rejects ambiguous consuming
handlers unless the author specifies ordering. Handlers can `consume event` to
stop later handlers after the current transaction commits.

## 6. Adventure commands

Commands are VM operations, not host calls:

- `enter room ... at ...` and `leave room`;
- `walk actor to ...`, `face actor ...`, and `stop actor`;
- `show`, `hide`, `enable`, `disable`, and component `set`;
- `play`/`stop` for declared animations and audio cues;
- `say`, `narrate`, and `choose` using localized text IDs;
- `add ... to inventory`, `remove ... from inventory`, and combinations;
- `camera` operations declared by the room; and
- `save checkpoint` as a request, never direct storage access.

All parameters come from declarations or typed expressions. For example, a
duration must be a configured constant or resource/room property rather than a
literal hidden in host code. The compiler may optionally warn on unexplained
numeric literals in scripts while still allowing legitimate puzzle arithmetic.

## 7. Concurrency and waiting

`task` functions are deterministic coroutines. `await` may wait for another
task, ticks, a declared timer, a typed event, movement, animation, audio, or a
dialogue result. Concurrent tasks are started with `spawn`; ownership must be
attached to `game`, a room, or an entity. Leaving a room cancels room-owned tasks
in a documented order. Cancellation runs no arbitrary cleanup; authors use a
`defer` block restricted to non-suspending state restoration.

There are no threads or races. Resumptions are ordered by VM event ordering, and
all handler writes become visible at transaction boundaries.

## 8. Errors and diagnostics

Compile diagnostics include stable code, severity, module, line/column range,
and related declarations. Errors include unresolved IDs, invalid handler
signatures, nonserializable suspended values, type mismatch, unreachable code,
unsafe recursion, and capability use absent from package configuration.

Runtime faults include a script stack and event context. A fault cancels the
current handler transaction; policy in package configuration determines whether
the VM stops, enters a debugger, or continues after reporting. A host cannot
select a different policy.

## 9. Compilation and versioning

The package declares its language version. Source compiles to a versioned,
host-neutral bytecode with a constant pool, typed functions, handler table,
debug/source map, and declared capability list. Bytecode may be cached, but
source plus package data remains authoritative and cache keys include compiler
version and content hashes.

Language evolution follows explicit versions. Removed syntax is never silently
reinterpreted. A package may ship precompiled bytecode only if it also declares
the exact VM ABI and integrity hash; development packages should keep source for
diagnostics and portability.

## 10. Grammar sketch

```ebnf
module       = "module", qualified_id, ";", { declaration } ;
declaration  = import | constant | state | function | event | handler ;
handler      = "on", event_pattern, [ "when", expression ], block ;
function     = [ "task" ], "fn", id, "(", parameters, ")",
               [ "->", type ], block ;
block        = "{", { statement }, "}" ;
statement    = let | set | if | match | while | for | command |
               await | emit | consume | return | expression, ";" ;
```

This sketch is intentionally not yet a parser specification. Before
implementation it must be completed with lexical rules, precedence, full command
grammar, bytecode opcodes, standard event schemas, and a conformance suite.
