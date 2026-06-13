@tool
class_name FFx
extends Node3D

var _owner: Variant = null
var _props: Dictionary = {}
var _is_setup: bool = false

signal finished


func setup(owner: Variant = null, props: Dictionary = {}) -> void:
	if _is_setup:
		return
	_owner = owner
	_props = props.duplicate(true)
	_is_setup = true
	on_setup()


func clear() -> void:
	if _is_setup:
		on_clear()
	_is_setup = false
	_owner = null
	_props.clear()


func on_setup() -> void:
	pass


func on_clear() -> void:
	pass


func play(_payload: Variant) -> void:
	pass


func finish() -> void:
	finished.emit()


func owner() -> Variant:
	return _owner


func has_prop(key: StringName) -> bool:
	return _props.has(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	return _props.get(key, fallback)
