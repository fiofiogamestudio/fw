extends "res://fw/scripts/fw/rt/system/_mode.gd"

const GameSystemScript = preload("res://scripts/system/game_system.gd")
const GameSystemContextScript = preload("res://scripts/system/game_system_context.gd")
const GraphScript = preload("res://scripts/gen/_graph.gd")


func enter(root: Variant, context: Variant = null) -> void:
	super.enter(root, context)

	var game_context = GameSystemContextScript.new()
	game_context.args.form_manager = form_manager()
	game_context.args.context = context

	add_system(&"game", GameSystemScript.new(), game_context)

	if not bind_system_refs(GraphScript.refs()):
		return
	init_systems()
