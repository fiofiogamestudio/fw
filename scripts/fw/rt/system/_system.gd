class_name BaseSystem
extends RefCounted

var _context: Variant


func init(context: Variant) -> void:
	_context = context


func tick(_dt: float) -> void:
	pass


func shutdown() -> void:
	pass
