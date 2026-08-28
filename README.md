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

## Current status

This repository currently contains the architecture and data-layout contract,
not an engine implementation. The package now specifies graphics fallback and
sprite timing semantics plus the classic verb/inventory layout without changing
the VM/host boundary.
