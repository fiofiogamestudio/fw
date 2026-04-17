class_name FUI
extends RefCounted

const LAYER_HUD: StringName = &"hud"
const LAYER_SCREEN: StringName = &"screen"
const LAYER_POPUP: StringName = &"popup"
const LAYER_MODAL: StringName = &"modal"
const LAYER_TOAST: StringName = &"toast"
const LAYER_TOOLTIP: StringName = &"tooltip"

const _LAYER_ORDER: Array[StringName] = [
	LAYER_HUD,
	LAYER_SCREEN,
	LAYER_POPUP,
	LAYER_MODAL,
	LAYER_TOAST,
	LAYER_TOOLTIP,
]

var _host: CanvasLayer = null
var _root: Control = null
var _layers: Dictionary = {}
var _forms: Dictionary = {}
var _layer_stacks: Dictionary = {}


func setup(host: CanvasLayer) -> void:
	_host = host
	_forms.clear()
	_layers.clear()
	_layer_stacks.clear()

	_root = Control.new()
	_root.name = "FUIRoot"
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_root.grow_vertical = Control.GROW_DIRECTION_BOTH
	_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_host.add_child(_root)

	for layer in _LAYER_ORDER:
		_create_layer(layer)


func root() -> Control:
	return _root


func layer_root(layer: StringName) -> Control:
	return _layers.get(layer, null) as Control


func show_hud(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	close_layer(LAYER_HUD)
	return _open(LAYER_HUD, id, packed_scene, context, props)


func push_screen(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	var previous: Variant = top_form(LAYER_SCREEN)
	if previous:
		previous.visible = false
	return _open(LAYER_SCREEN, id, packed_scene, context, props)


func push_popup(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	return _open(LAYER_POPUP, id, packed_scene, context, props)


func push_modal(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	return _open(LAYER_MODAL, id, packed_scene, context, props)


func show_toast(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	return _open(LAYER_TOAST, id, packed_scene, context, props)


func show_tooltip(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	close_layer(LAYER_TOOLTIP)
	return _open(LAYER_TOOLTIP, id, packed_scene, context, props)


func open(
	layer: StringName,
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	return _open(layer, id, packed_scene, context, props)


func has(id: StringName) -> bool:
	return _forms.has(id)


func get_form(id: StringName) -> Variant:
	return _forms.get(id, null)


func top_form(layer: StringName) -> Variant:
	var stack: Array = _layer_stacks.get(layer, [])
	if stack.is_empty():
		return null
	return get_form(StringName(stack[-1]))


func close(id: StringName) -> void:
	var form: Variant = _forms.get(id, null)
	if form == null:
		return

	var layer: StringName = form.layer()
	if form.has_method("shutdown"):
		form.shutdown()
	if is_instance_valid(form):
		form.queue_free()
	_forms.erase(id)
	_remove_from_stack(layer, id)

	if layer == LAYER_SCREEN:
		var previous: Variant = top_form(LAYER_SCREEN)
		if previous:
			previous.visible = true


func close_top(layer: StringName) -> void:
	var top: Variant = top_form(layer)
	if top:
		close(top.form_id())


func close_layer(layer: StringName) -> void:
	var stack: Array = _layer_stacks.get(layer, []).duplicate()
	for i in range(stack.size() - 1, -1, -1):
		close(StringName(stack[i]))


func close_all() -> void:
	for layer in _LAYER_ORDER:
		close_layer(layer)


func _open(
	layer: StringName,
	id: StringName,
	packed_scene: PackedScene,
	context: Variant,
	props: Dictionary
) -> Variant:
	var layer_root_node: Control = layer_root(layer)
	if layer_root_node == null:
		push_error("FUI layer '%s' is not ready." % String(layer))
		return null
	if packed_scene == null:
		push_error("FUI cannot open an empty form scene.")
		return null

	close(id)

	var form: Variant = packed_scene.instantiate()
	if form == null:
		push_error("FUI failed to instantiate form '%s'." % String(id))
		return null
	if not form.has_method("assign_runtime"):
		push_error("FUI can only open scenes whose root extends FForm.")
		if form is Node:
			form.queue_free()
		return null

	form.name = String(id)
	layer_root_node.add_child(form)
	form.assign_runtime(self, layer, id)
	form.init(context, props)

	_forms[id] = form
	_push_to_stack(layer, id)
	return form


func _create_layer(layer: StringName) -> void:
	var node := Control.new()
	node.name = _layer_name(layer)
	node.set_anchors_preset(Control.PRESET_FULL_RECT)
	node.grow_horizontal = Control.GROW_DIRECTION_BOTH
	node.grow_vertical = Control.GROW_DIRECTION_BOTH
	node.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(node)
	_layers[layer] = node
	_layer_stacks[layer] = []


func _push_to_stack(layer: StringName, id: StringName) -> void:
	var stack: Array = _layer_stacks.get(layer, [])
	stack.append(id)
	_layer_stacks[layer] = stack


func _remove_from_stack(layer: StringName, id: StringName) -> void:
	var stack: Array = _layer_stacks.get(layer, [])
	var next_stack: Array = []
	for raw_id in stack:
		var stack_id: StringName = StringName(raw_id)
		if stack_id != id:
			next_stack.append(stack_id)
	_layer_stacks[layer] = next_stack


func _layer_name(layer: StringName) -> String:
	match layer:
		LAYER_HUD:
			return "HUDLayer"
		LAYER_SCREEN:
			return "ScreenLayer"
		LAYER_POPUP:
			return "PopupLayer"
		LAYER_MODAL:
			return "ModalLayer"
		LAYER_TOAST:
			return "ToastLayer"
		LAYER_TOOLTIP:
			return "TooltipLayer"
		_:
			return "%sLayer" % String(layer).capitalize()
