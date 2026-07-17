@tool
class_name FViewRoot
extends Node3D

const FViewStoreScript = preload("res://fw/scripts/fw/vu/_view_store.gd")

@export var refs: Dictionary[String, NodePath] = {}
@export var props: Dictionary[String, Variant] = {}

var _view: Variant = null
var _owner: Variant = null
var _is_setup: bool = false

signal action(name: StringName, payload: Dictionary)


func _enter_tree() -> void:
	_ensure_view()


func _exit_tree() -> void:
	clear()


func setup(owner: Variant = null, props: Dictionary = {}) -> void:
	if _is_setup:
		return
	_owner = owner
	_ensure_view()
	apply_props(props)
	_is_setup = true
	on_setup()


func clear() -> void:
	if _is_setup:
		on_clear()
	_is_setup = false
	clear_bindings()
	if _view:
		_view.clear()
	_view = null
	_owner = null


func on_setup() -> void:
	pass


func on_clear() -> void:
	pass


func apply(_vm: Variant, _dt: float = 0.0) -> void:
	pass


func owner() -> Variant:
	return _owner


func emit_action(name: StringName, payload: Dictionary = {}) -> void:
	action.emit(name, payload)


func create_binding() -> Variant:
	_ensure_view()
	return _view.create_binding()


func clear_bindings() -> void:
	if _view:
		_view.clear_bindings()


func ref_store() -> Variant:
	_ensure_view()
	return _view.ref_store()


func prop_store() -> Variant:
	_ensure_view()
	return _view.prop_store()


func register_ref(key: StringName, raw_path: Variant) -> void:
	_ensure_view()
	_view.set_ref(key, raw_path)


func register_refs(values: Dictionary) -> void:
	_ensure_view()
	_view.set_refs(values)


func has_ref(key: StringName) -> bool:
	return _view != null and _view.has_ref(key)


func get_ref(key: StringName) -> Node:
	if _view == null:
		return null
	return _view.get_ref(key)


func require_ref(key: StringName, expected_type: Variant = null) -> Node:
	_ensure_view()
	return _view.require_ref(key, expected_type)


func has_prop(key: StringName) -> bool:
	return _view != null and _view.has_prop(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	if _view == null:
		return fallback
	return _view.get_prop(key, fallback)


func apply_props(overrides: Dictionary) -> void:
	_ensure_view()
	_view.apply_props(overrides)


func resolved_props() -> Dictionary:
	if _view == null:
		return {}
	return _view.resolved_props()


func set_view_model(vm: Variant) -> void:
	_ensure_view()
	_view.set_view_model(vm)


func view_model() -> Variant:
	if _view == null:
		return null
	return _view.view_model()


func require_node(path: NodePath) -> Node:
	_ensure_view()
	return _view.require_node(path)


func _ensure_view() -> void:
	if _view != null:
		return
	_view = FViewStoreScript.new()
	_view.setup(self, refs, props)
