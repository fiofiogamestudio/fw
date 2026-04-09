class_name FForm
extends Control

const FBindingScript = preload("../_binding.gd")
const FUiEventScript = preload("../_ui_event.gd")

var _context: Variant = null
var _form_id: StringName = &""
var _node_cache: Dictionary = {}
var _bindings: Array = []
var _ui_event: Variant


func init(context: Variant) -> void:
	_context = context
	_ui_event = FUiEventScript.new()


func tick(_dt: float) -> void:
	pass


func shutdown() -> void:
	clear_bindings()
	if _ui_event:
		_ui_event.clear()
	_ui_event = null
	_node_cache.clear()
	_form_id = &""
	_context = null


func form_context() -> Variant:
	return _context


func assign_form_id(id: StringName) -> void:
	_form_id = id


func form_id() -> StringName:
	return _form_id


func ui_event() -> Variant:
	return _ui_event


func create_binding() -> Variant:
	var binding = FBindingScript.new()
	_bindings.append(binding)
	return binding


func clear_bindings() -> void:
	for binding in _bindings:
		if binding:
			binding.unbind()
	_bindings.clear()


func require_node(path: NodePath) -> Node:
	if _node_cache.has(path):
		return _node_cache[path]
	var node: Node = get_node_or_null(path)
	if node == null:
		push_error("FForm missing required node: %s" % String(path))
		return null
	_node_cache[path] = node
	return node
