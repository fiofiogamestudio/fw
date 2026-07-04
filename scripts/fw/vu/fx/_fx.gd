@tool
class_name FFx
extends Node3D

var _owner: Variant = null
var _props: Dictionary = {}
var _is_setup: bool = false
var _active_tween: Tween = null

signal finished


func setup(owner: Variant = null, props: Dictionary = {}) -> void:
	if _is_setup:
		return
	_owner = owner
	_props = props.duplicate(true)
	_is_setup = true
	on_setup()


func clear() -> void:
	_kill_active_tween()
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


func create_fx_tween() -> Tween:
	_kill_active_tween()
	_active_tween = create_tween()
	return _active_tween


func finish() -> void:
	_active_tween = null
	finished.emit()


func owner() -> Variant:
	return _owner


func has_prop(key: StringName) -> bool:
	return _props.has(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	return _props.get(key, fallback)


func _kill_active_tween() -> void:
	if _active_tween != null and _active_tween.is_valid():
		_active_tween.kill()
	_active_tween = null
