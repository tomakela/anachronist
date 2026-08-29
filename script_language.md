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

Source is UTF-8. Blocks use braces and `//` starts a line comment. A physical
newline (or a closing brace) terminates a simple statement; blank lines and
comments do not. Semicolons are invalid, and two simple statements cannot share
a line. Newlines inside parenthesized delimiter lists are only formatting.

## 2. Variables and owned scripts

Persistent variables are declarations at the beginning of an INI file, before
its first section. Values may be booleans, integers, quoted strings, or bare INI
values:

```ini
door_unlocked = false
player_name = "Ada"

[package]
id = example
```

Variables in `game.ini` are available everywhere as `game.door_unlocked` and
`game.player_name`. Variables at the beginning of a room's `room.ini` use the
room catalogue ID as their namespace, such as `hall.visited`. Every room's
variables are created and initialized while the game package starts, not when
the player first enters that room. `set` changes either kind of variable. The
prefixes make ownership clear by convention; they are not visibility barriers.

The package entry and each room have a script:

```ana
on game.start() {
    enter room foyer at entry
}
```

There is no `module` declaration: catalogue entries own source files. The
package entry script contains package-wide initialization. Room scripts have an
implicit room context: `on enter()` lowers to guarded `room.enter`, and
`on door.open()` lowers to `entity.open` with local target `door`. Loading
rejects unknown or ambiguous local entity names. Parentheses around `if`
conditions are optional.

State must be explicitly scoped as `game`, a room ID, or `entity`. Ordinary local
variables use `let` and disappear when their call finishes unless captured by a
serializable suspended coroutine.

The version 1 interpreter resolves qualified variable expressions against the
persistent VM state. Taking an entity deliberately does not modify its room
file: the demo sets `game.key_taken` when acquiring the key, then tests that
global and hides the original room entity when the player returns to the hall.

Inventory items may independently own scripts through the item catalogue. An
item script is not tied to a room and its short handlers implicitly target that
item. For example, `on look()` in `coffee_cup.ana` handles looking at the coffee
cup in whichever room currently contains the player.

Rooms can also be cut scenes. `interactive = false` disables pointing and
verbs, `interface_visible = false` hides the verb and inventory interface, and
`fullscreen = true` lets room artwork occupy the whole logical display. Cut
scene scripts use the same deterministic commands, including `wait N ticks`,
and normally enter another room when their sequence finishes.

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
- interaction: `entity.look`, `entity.use`, `entity.take`, `entity.open`,
  `entity.close`, `entity.talk`, `entity.use_item`, the default `walk` action,
  and game-defined verb events;
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
- `shake N ticks` for a deterministic, game-configured screen shake;
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

## 10. Normative lexical grammar

The following rules are normative for language version 1. Whitespace separates
tokens. A line comment begins with `//` and ends immediately before LF or at
EOF. Identifiers match `[A-Za-z_][A-Za-z0-9_]*`; a qualified identifier is two
or more identifiers separated by `.`. Reserved words may not be identifiers.
Strings use double quotes and support `\\`, `\"`, `\n`, `\r`, `\t`, and
`\u{hex}` escapes. Source code must not contain unpaired Unicode surrogates.
Integer literals are decimal or `0x` hexadecimal; fixed literals contain a
decimal point and optional `fixed` suffix. Leading signs are unary operators.

The longest valid token is always selected. Source locations count Unicode
scalar values, with lines and columns starting at one. A UTF-8 BOM is permitted
only at the beginning of a module.

## 11. Normative grammar

```ebnf
source        = { handler } ;
declaration   = import | constant | state | function | event | handler ;
import        = "import", ("room"|"resource"|"module"), qualified_id, ";" ;
constant      = "const", id, [ ":", type ], "=", expression, ";" ;
state         = "state", ("game"|"room"|"entity"), id, "{", { field }, "}" ;
field         = type, id, [ "=", expression ], ";" ;
function      = [ "task" ], "fn", id, "(", [ parameters ], ")",
                [ "->", type ], block ;
event         = "event", qualified_id, "(", [ parameters ], ")", ";" ;
handler       = "on", qualified_id, "(", [ arguments ], ")",
                [ "when", expression ], [ "priority", integer ], block ;
parameters    = parameter, { ",", parameter } ;
parameter     = id, ":", type ;
arguments     = (id | id, ":", type), { ",", (id | id, ":", type) } ;
type          = primitive | domain | ("list"|"option"), "<", type, ">" |
                "map", "<", type, ",", type, ">" ;
block         = "{", { statement }, "}" ;
statement     = let | set | if | match | while | for | break | continue |
                return | emit | consume | await | spawn | defer | sequence |
                command | expression, ";" ;
sequence      = "sequence", block ;
let           = "let", id, [ ":", type ], "=", expression, ";" ;
set           = "set", assignable, "=", expression, ";" ;
if            = "if", [ "(" ], expression, [ ")" ], block, [ "else", (block|if) ] ;
while         = "while", "(", expression, ")", block ;
for           = "for", id, "in", expression, block ;
return        = "return", [ expression ], ";" ;
expression    = coalesce ;
coalesce      = logical_or, { "??", logical_or } ;
logical_or    = logical_and, { "||", logical_and } ;
logical_and   = equality, { "&&", equality } ;
equality      = comparison, { ("=="|"!="), comparison } ;
comparison    = term, { ("<"|"<="|">"|">="), term } ;
term          = factor, { ("+"|"-"), factor } ;
factor        = unary, { ("*"|"/"|"%"), unary } ;
unary         = ("!"|"-"), unary | postfix ;
postfix       = primary, { ".", id | "[", expression, "]" |
                 "(", [ expression, { ",", expression } ], ")" } ;
primary       = literal | qualified_id | list | map | "(", expression, ")" ;
```

`match`, adventure commands, suspension statements, and collection literals use
the spellings and operand order specified in sections 4–7. Operators on one row
above have equal precedence and associate left-to-right; unary and postfix
operators associate right-to-left and left-to-right respectively.

## 12. Interpreter transaction requirement

An input gesture first resolves a handler and expands its complete `sequence`
into a validated command list. Only after parsing, reference resolution, guard
evaluation, and expansion succeed is that list appended to the VM queue. No
command from a malformed or incomplete chain may execute. Consequently a
scripted `walk; take; walk; use` interaction cannot begin walking while the
remainder of that action is still being constructed. `sequence` is not a
concurrency primitive; it makes this command-planning boundary explicit.

### Skippable presentation

A handler may put `skippable` between its signature and body, for example
`on enter() skippable { ... }`. A skip gesture accelerates or suppresses only
walking animation, waits, dialogue duration, animation, and screen shake. State
mutations and room transitions remain queued and execute in source order.
Handlers are non-skippable by default, so clicks cannot bypass puzzle logic.
