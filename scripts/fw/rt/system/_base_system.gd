class_name BaseSystem
extends RefCounted

var _context: Variant


func init(context: Variant) -> bool:
	if context == null:
		push_error("System requires a valid context.")
		return false
	_context = context
	return true


func tick(_dt: float) -> void:
	pass


func shutdown() -> void:
	_context = null
