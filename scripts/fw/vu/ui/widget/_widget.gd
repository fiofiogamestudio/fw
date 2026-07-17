@tool
class_name FWidget
extends Control

const FViewStoreScript = preload("res://fw/scripts/fw/vu/_view_store.gd")

@export var refs: Dictionary[String, NodePath] = {}
@export var props: Dictionary[String, Variant] = {}

var _is_ready: bool = false
var _owner_form: Variant = null
var _view: Variant = null

signal action(name: StringName, payload: Dictionary)


func setup(owner: Variant = null, props: Dictionary = {}) -> void:
	if not _begin_setup(owner, props):
		return
	_finish_setup()


func _begin_setup(owner: Variant, overrides: Dictionary) -> bool:
	if _is_ready:
		return false
	_owner_form = owner
	_view = FViewStoreScript.new()
	_view.setup(self, refs, self.props, overrides)
	_is_ready = true
	return true


func _finish_setup() -> void:
	on_setup()


func clear() -> void:
	if not _begin_clear():
		return
	_finish_clear()


func _begin_clear() -> bool:
	if not _is_ready:
		return false
	on_clear()
	return true


func _finish_clear() -> void:
	_is_ready = false
	if _view:
		_view.clear()
	_view = null
	_owner_form = null


func is_setup() -> bool:
	return _is_ready


func on_setup() -> void:
	pass


func on_clear() -> void:
	pass


func apply(_vm: Variant, _dt: float = 0.0) -> void:
	pass


func emit_action(name: StringName, payload: Dictionary = {}) -> void:
	action.emit(name, payload)


func skip_auto_widget_setup() -> bool:
	return false


func owner_form() -> Variant:
	return _owner_form


func create_binding() -> Variant:
	if _view == null:
		return null
	return _view.create_binding()


func clear_bindings() -> void:
	if _view:
		_view.clear_bindings()


func ref_store() -> Variant:
	if _view == null:
		return null
	return _view.ref_store()


func prop_store() -> Variant:
	if _view == null:
		return null
	return _view.prop_store()


func has_ref(key: StringName) -> bool:
	return _view != null and _view.has_ref(key)


func get_ref(key: StringName) -> Node:
	if _view == null:
		return null
	return _view.get_ref(key)


func require_ref(key: StringName, expected_type: Variant = null) -> Node:
	if _view == null:
		push_error("FWidget refs are not ready.")
		return null
	return _view.require_ref(key, expected_type)


func has_prop(key: StringName) -> bool:
	return _view != null and _view.has_prop(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	if _view == null:
		return fallback
	return _view.get_prop(key, fallback)


func apply_props(props: Dictionary) -> void:
	if _view == null:
		return
	_view.apply_props(props)


func resolved_props() -> Dictionary:
	if _view == null:
		return {}
	return _view.resolved_props()


func set_view_model(vm: Variant) -> void:
	if _view:
		_view.set_view_model(vm)


func view_model() -> Variant:
	if _view == null:
		return null
	return _view.view_model()


func require_node(path: NodePath) -> Node:
	if _view == null:
		push_error("FWidget view is not ready.")
		return null
	return _view.require_node(path)
