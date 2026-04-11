extends "res://fw/scripts/fw/rt/system/_base_system.gd"


func init(context: Variant) -> void:
	super.init(context)


func increment_press_count() -> void:
	_context.state.press_count += 1


func get_press_count() -> int:
	return _context.state.press_count
