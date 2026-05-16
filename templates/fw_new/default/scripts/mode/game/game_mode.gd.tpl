extends "res://fw/scripts/fw/rt/system/_base_mode.gd"

const GameLogicScript = preload("res://scripts/mode/game/feature/game_logic.gd")
const GameFormScene = preload("res://prefabs/ui/game_form.tscn")
const GodotSystemsScript = preload("res://scripts/_gen/_godot_systems.gd")

var _game_logic: Variant = null
var _game_system: Variant = null


func enter(root: Variant, context: Variant = null) -> void:
	super.enter(root, context)

	var entries: Dictionary = GodotSystemsScript.setup(self)
	if entries.is_empty():
		return
	var game_entry: Dictionary = entries.get(&"game", {})
	_game_system = game_entry.get("system", null)
	var game_context: Variant = game_entry.get("context", null)
	game_context.config.project_name = context.config.project_name
	game_context.config.subtitle = context.config.subtitle
	game_context.config.status_message = context.config.status_message

	init_systems()

	_game_logic = GameLogicScript.new()
	_game_logic.attach_ui(ui())
	_game_logic.enter(GameFormScene, context, _game_system)


func tick(dt: float) -> void:
	super.tick(dt)
	if _game_logic:
		_game_logic.tick(dt)


func exit() -> void:
	if _game_logic:
		_game_logic.exit()
	_game_logic = null
	_game_system = null
	super.exit()
