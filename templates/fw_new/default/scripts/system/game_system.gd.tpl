extends "res://fw/scripts/fw/rt/system/_base_system.gd"

const GameLogicScript = preload("res://scripts/app/game_logic.gd")
const GameFormScene = preload("res://prefabs/ui/game_form.tscn")


func init(context: Variant) -> void:
	super.init(context)

	var logic = GameLogicScript.new()
	_context.state.logic = logic
	logic.attach_forms(_context.args.form_manager)
	logic.enter(GameFormScene, _context.args.context)


func shutdown() -> void:
	if _context == null:
		return
	if _context.state.logic and _context.state.logic.has_method("exit"):
		_context.state.logic.exit()
	_context.state.logic = null
