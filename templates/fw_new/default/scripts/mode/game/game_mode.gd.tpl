extends "res://fw/scripts/fw/rt/system/_base_mode.gd"

const GameLogicScript = preload("res://scripts/mode/game/feature/game_logic.gd")
const GameFormScene = preload("res://prefabs/form/game_form.tscn")
const GodotSystemsScript = preload("res://scripts/_gen/_godot_systems.gd")

var _game_logic: Variant = null
var _game_system_context: Variant = null


func enter(root: Variant, context: Variant = null) -> bool:
	if not super.enter(root, context):
		return false

	var entries: Dictionary = GodotSystemsScript.setup(self)
	if entries.is_empty():
		return fail_enter("Game systems failed to register.")
	var game_entry: Dictionary = entries.get(&"game", {})
	_game_system_context = game_entry.get("context", null)
	if _game_system_context == null:
		return fail_enter("Game system context is missing.")
	_game_system_context.config.project_name = context.config.project_name
	_game_system_context.config.subtitle = context.config.subtitle
	_game_system_context.config.status_message = context.config.status_message

	if not init_systems():
		return fail_enter("Game systems failed to initialize.")

	_game_logic = GameLogicScript.new()
	_game_logic.attach_ui(ui())
	_game_logic.enter(GameFormScene, context, _game_system_context)
	return true


func tick(dt: float) -> void:
	super.tick(dt)
	if _game_logic:
		_game_logic.tick(dt)


func exit() -> void:
	if _game_logic:
		_game_logic.exit()
	_game_logic = null
	_game_system_context = null
	super.exit()
