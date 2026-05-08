# Fw Framework Design Report

## Scope
This report reviews the current `fw` submodule as a reusable Godot + C# game framework.
It focuses on structure, operating principles, strengths, risks, and possible improvements.

## Current Structure
- `fw/scripts/fw/rt/system` provides the GDScript runtime spine: `AppRoot`, `BaseMode`, `BaseSystem`, and `SystemManager`.
- `fw/scripts/fw/rt/pool` provides prefab pooling through `PoolManager` and pool nodes.
- `fw/scripts/fw/vu` provides view utilities, refs, props, bindings, view roots, UI layers, forms, widgets, and common UI components.
- `fw/csharp/FwRuntime` provides the C# `SystemRuntime` and generic `ISystem<TContext>` contract.
- `fw/csharp/FwGen` provides code generation for GDScript systems, C# core systems, bridge contracts/codecs, config contracts, config packs, and `fw new`.
- `fw/tools` provides project-facing command wrappers: `gen`, `build`, and `new`.
- `fw/templates/fw_new/default` is the starter template used by `fw new`.
- `fw/docs` is the framework-side documentation source for framework behavior and usage.
- `fw/hooks/pre-commit` syncs host docs and skill files back into templates before committing the `fw` repository.

## Operating Principles
- The framework is not a game runtime by itself; it is a normative scaffold for games built with Godot presentation and C# gameplay core.
- GDScript and C# share the same system vocabulary: `id`, `phase`, `context`, `init`, `tick`, and `shutdown`.
- The shared part is the architecture pattern, not identical source files.
- GDScript systems are declared by the host project in `schema/system.toml`, then generated into `_systems.gd` and `_graph.gd`.
- C# core systems are declared by the host project in `schema/core_system.toml`, then generated into `core_systems.cs`.
- Bridge and config contracts are generated from proto-like schema files so both sides use stable field names and packet constants.
- The framework keeps cross-game reusable infrastructure in `fw`, while concrete gameplay remains in the host project.

## Runtime Flow
- `AppRoot` creates the mode host, pool manager, UI root, and UI runtime, then calls `on_app_ready`.
- A host game extends `AppRoot` and uses `switch_mode` to enter app-specific modes.
- `BaseMode` owns a `SystemManager` and delegates mode ticking to registered systems.
- `SystemManager` registers systems by id and phase, binds context refs from generated graph data, initializes systems in phase order, ticks them in phase order, and shuts them down in reverse order.
- `FUI` manages stable UI layers: HUD, screen, popup, modal, toast, and tooltip.
- `FViewRoot` and `FView` give non-form scene roots the same refs/props style as forms without forcing every scene to become a form.
- `SystemRuntime` in C# mirrors the phase-based system lifecycle for core gameplay.

## Generation Flow
- `Program.cs` dispatches commands such as `system`, `bridge`, `config`, `check-config`, `pak-config`, and `craft`.
- `FwConfig.cs` reads `fw.toml`, which acts as the host project's generation map.
- `SystemGen.cs` generates GDScript system factories and system graph refs.
- `CoreSystemGen.cs` generates the C# core system registry and phase constants.
- `BridgeGen.cs` generates bridge field constants, packet helpers, GDScript wrappers, C# input decoding, and C# event encoding.
- `ConfigGen.cs` generates typed config contracts and config field constants.
- `Craft.cs` copies `fw/templates/fw_new/default` into a host project and immediately runs generation.

## Strengths
- The framework has a small and readable runtime core.
- GDScript and C# now share the same mental model, which reduces context switching when moving between presentation and core logic.
- Generated system graph removes manual ref-binding mistakes in GDScript.
- Generated C# core system registration removes manual phase-order drift.
- Bridge and config generation reduce duplicate constants and field names across language boundaries.
- `fw new` makes the framework reusable for future games instead of being tightly coupled to this one project.
- UI layering and form lifecycle are centralized, so host games do not need to reinvent basic screen management.
- The pre-commit hook gives the framework author a practical way to keep templates aligned with host docs and skill rules.

## Weaknesses and Risks
- `BridgeGen.cs` is still the largest generator file, so bridge generation is the current complexity hotspot inside `fw`.
- `SystemManager` checks refs dynamically in GDScript, which is flexible but only fails at runtime.
- `FwConfig` is intentionally simple and only parses the subset of TOML currently needed; this is fine now but not a full TOML parser.
- The framework currently provides runtime and generation conventions, but not much testing infrastructure for generated projects.
- `FViewRoot` is useful but still young; the boundary between pure view refs/props and project-specific presentation logic needs continued discipline.
- The pre-commit hook assumes the host repo is the parent directory of `fw`, which matches this workflow but is not a universal submodule layout.

## Possible Improvements
- Split `BridgeGen.cs` by output responsibility, for example C# contract, C# codec, GDScript wrapper, and packet helpers.
- Add generator-level tests using small fixture schemas, especially for bridge and config outputs.
- Add a `fw check` command that runs generation in dry-run mode and reports stale generated files.
- Make the hook behavior explicit in `fw/docs/use.md` and keep it opt-in through `core.hooksPath`.
- Consider compile-time validation for C# core system ids/phases if future core graphs gain refs.
- Add a minimal project verification command for `fw new` templates that creates a temp project, builds it, and deletes it.

## Overall Assessment
The `fw` framework is already usable as a reusable game scaffold. Its current strongest idea is the unified system-context lifecycle across GDScript and C#, backed by schema-driven generation. The main thing to protect going forward is boundary discipline: framework code should stay generic, host gameplay should stay outside `fw`, and generated files should remain derived products rather than new sources of truth.
