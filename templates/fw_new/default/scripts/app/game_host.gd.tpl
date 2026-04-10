class_name GameHost
extends RefCounted

const GameLogicScript = preload("res://scripts/app/game_logic.gd")
const GameFormScene = preload("res://prefabs/ui/game_form.tscn")

var _logic: Variant = null


func enter(forms: Variant, context: Variant, system: Variant) -> void:
	_logic = GameLogicScript.new()
	_logic.attach_forms(forms)
	_logic.enter(GameFormScene, context, system)


func tick(dt: float) -> void:
	if _logic:
		_logic.tick(dt)


func shutdown() -> void:
	if _logic:
		_logic.exit()
	_logic = null
