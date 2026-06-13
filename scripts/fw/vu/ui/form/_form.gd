@tool
class_name FForm
extends "../widget/_widget.gd"

const FUIEventScript = preload("../_ui_event.gd")
const FWidgetScript = preload("../widget/_widget.gd")

var _context: Variant = null
var _form_id: StringName = &""
var _layer: StringName = &""
var _ui: Variant = null
var _ui_event: Variant


func setup(context: Variant = null, props: Dictionary = {}) -> void:
	_context = context
	_ui_event = FUIEventScript.new()
	super.setup(self, props)
	_setup_child_widgets(self)


func tick(_dt: float) -> void:
	pass


func clear() -> void:
	_shutdown_child_widgets(self)
	clear_bindings()
	if _ui_event:
		_ui_event.clear()
	_ui_event = null
	super.clear()
	_form_id = &""
	_layer = &""
	_ui = null
	_context = null


func form_context() -> Variant:
	return _context


func assign_form_id(id: StringName) -> void:
	_form_id = id


func form_id() -> StringName:
	return _form_id


func assign_runtime(ui: Variant, layer: StringName, id: StringName) -> void:
	_ui = ui
	_layer = layer
	_form_id = id


func ui() -> Variant:
	return _ui


func layer() -> StringName:
	return _layer


func ui_event() -> Variant:
	return _ui_event


func _setup_child_widgets(node: Node) -> void:
	for child in node.get_children():
		if is_instance_of(child, FWidgetScript) and child != self and not child.skip_auto_widget_setup():
			child.setup(self)
		_setup_child_widgets(child)


func _shutdown_child_widgets(node: Node) -> void:
	var children: Array = node.get_children()
	for i in range(children.size() - 1, -1, -1):
		var child: Node = children[i]
		_shutdown_child_widgets(child)
		if is_instance_of(child, FWidgetScript) and child != self and not child.skip_auto_widget_setup():
			child.clear()
