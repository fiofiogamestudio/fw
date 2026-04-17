@tool
class_name FWidget
extends Control

const FViewScript = preload("res://fw/scripts/fw/vu/_view.gd")

@export var refs: Dictionary[String, NodePath] = {}
@export var props: Dictionary[String, Variant] = {}

var _is_ready: bool = false
var _owner_form: Variant = null
var _view: Variant = null


func setup_widget(owner_form: Variant, props: Dictionary = {}) -> void:
	_owner_form = owner_form
	_view = FViewScript.new()
	_view.setup(self, refs, self.props, props)
	_is_ready = true
	on_widget_ready()


func shutdown_widget() -> void:
	if _is_ready:
		on_widget_shutdown()
	_is_ready = false
	if _view:
		_view.clear()
	_view = null
	_owner_form = null


func on_widget_ready() -> void:
	pass


func on_widget_shutdown() -> void:
	pass


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
