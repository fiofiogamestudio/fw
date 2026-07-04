[godot.phases]
order = ["present"]

[godot.system.game]
phase = "present"
script = "res://scripts/mode/game/system/game_system.gd"
context = "res://scripts/mode/game/system/game_system_context.gd"

[core.phases]
order = ["simulation"]

[core.system.simulation]
phase = "simulation"
type = "GameSystem"
