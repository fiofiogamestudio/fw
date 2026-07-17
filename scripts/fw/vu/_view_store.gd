class_name FViewStore
extends RefCounted

const FBindingScript = preload("res://fw/scripts/fw/vu/_binding.gd")
const FPropsScript = preload("res://fw/scripts/fw/vu/_props.gd")
const FRefsScript = preload("res://fw/scripts/fw/vu/_refs.gd")

var _owner: Node = null
var _bindings: Array = []
var _node_cache: Dictionary = {}
var _props: Variant = null
var _refs: Variant = null
var _view_model: Variant = null


func setup(owner: Node, refs: Dictionary, props: Dictionary, overrides: Dictionary = {}) -> void:
	_owner = owner
	_refs = FRefsScript.new()
	_refs.setup(owner, refs)
	_props = FPropsScript.new()
	_props.setup(props, overrides)


func clear() -> void:
	clear_bindings()
	_node_cache.clear()
	_view_model = null
	if _refs:
		_refs.clear()
	_refs = null
	if _props:
		_props.clear()
	_props = null
	_owner = null


func create_binding() -> Variant:
	var binding: Variant = FBindingScript.new()
	_bindings.append(binding)
	return binding


func clear_bindings() -> void:
	for binding in _bindings:
		if binding:
			binding.unbind()
	_bindings.clear()


func ref_store() -> Variant:
	return _refs


func prop_store() -> Variant:
	return _props


func has_ref(key: StringName) -> bool:
	return _refs != null and _refs.has_ref(key)


func set_ref(key: StringName, raw_path: Variant) -> void:
	if _refs == null:
		return
	_refs.set_ref(key, raw_path)


func set_refs(values: Dictionary) -> void:
	if _refs == null:
		return
	for raw_key in values.keys():
		var key: StringName = StringName(raw_key)
		_refs.set_ref(key, values[raw_key])


func get_ref(key: StringName) -> Node:
	if _refs == null:
		return null
	return _refs.get_ref(key)


func require_ref(key: StringName, expected_type: Variant = null) -> Node:
	if _refs == null:
		push_error("FViewStore refs are not ready.")
		return null
	return _refs.require_ref(key, expected_type)


func has_prop(key: StringName) -> bool:
	return _props != null and _props.has_prop(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	if _props == null:
		return fallback
	return _props.get_prop(key, fallback)


func apply_props(overrides: Dictionary) -> void:
	if _props == null:
		return
	_props.apply_props(overrides)


func resolved_props() -> Dictionary:
	if _props == null:
		return {}
	return _props.resolved_props()


func set_view_model(vm: Variant) -> void:
	_view_model = vm


func view_model() -> Variant:
	return _view_model


func require_node(path: NodePath) -> Node:
	if _node_cache.has(path):
		var raw_cached: Variant = _node_cache[path]
		if is_instance_valid(raw_cached) and raw_cached is Node:
			var cached: Node = raw_cached
			return cached
		_node_cache.erase(path)
	if _owner == null or not is_instance_valid(_owner):
		push_error("FViewStore owner is not ready.")
		return null
	var node: Node = _owner.get_node_or_null(path)
	if node == null:
		push_error("FViewStore missing required node: %s" % String(path))
		return null
	_node_cache[path] = node
	return node
