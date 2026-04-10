extends "res://fw/scripts/fw/rt/system/_base_mode.gd"

const GameHostScript = preload("res://scripts/app/game_host.gd")
const GameSystemScript = preload("res://scripts/system/game_system.gd")
const GameSystemContextScript = preload("res://scripts/system/game_system_context.gd")
const GraphScript = preload("res://scripts/gen/_graph.gd")

var _game_host: Variant = null
var _game_system: Variant = null


func enter(root: Variant, context: Variant = null) -> void:
	super.enter(root, context)

	var game_context = GameSystemContextScript.new()
	game_context.config.project_name = context.config.project_name
	game_context.config.subtitle = context.config.subtitle
	game_context.config.status_message = context.config.status_message

	_game_system = GameSystemScript.new()
	add_system(&"game", _game_system, game_context)

	if not bind_system_refs(GraphScript.refs()):
		return
	init_systems()

	_game_host = GameHostScript.new()
	_game_host.enter(form_manager(), context, _game_system)


func tick(dt: float) -> void:
	super.tick(dt)
	if _game_host:
		_game_host.tick(dt)


func exit() -> void:
	if _game_host:
		_game_host.shutdown()
	_game_host = null
	_game_system = null
	super.exit()
