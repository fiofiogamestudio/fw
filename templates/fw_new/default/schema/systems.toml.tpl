[godot.phases]
order = ["presentation"]

[godot.system.game]
phase = "presentation"
script = "res://scripts/mode/game/system/game_system.gd"
context = "res://scripts/mode/game/system/game_system_context.gd"

[core.phases]
order = ["simulation"]

[core.system.simulation]
phase = "simulation"
type = "GameSystem"
