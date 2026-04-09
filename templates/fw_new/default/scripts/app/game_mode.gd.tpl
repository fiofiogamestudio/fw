extends "res://fw/scripts/fw/rt/system/_mode.gd"

const GameSystemScript = preload("res://scripts/system/game_system.gd")
const GameContextScript = preload("res://scripts/system/game_context.gd")
const GraphScript = preload("res://scripts/gen/_graph.gd")


func enter(root: Variant, context: Variant = null) -> void:
	super.enter(root, context)

	var game_context = GameContextScript.new()
	game_context.args.form_manager = form_manager()
	game_context.args.mode_context = context

	add_system(&"game", GameSystemScript.new(), game_context)

	if not bind_system_refs(GraphScript.refs()):
		return
	init_systems()
