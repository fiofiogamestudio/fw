class_name FUI
extends RefCounted

const FFormScript = preload("form/_form.gd")

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
	clear()
	if host == null or not is_instance_valid(host):
		push_error("FUI requires a valid CanvasLayer host.")
		return
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


func clear() -> void:
	close_all()
	if _root != null and is_instance_valid(_root):
		if _root.get_parent():
			_root.get_parent().remove_child(_root)
		_root.queue_free()
	_root = null
	_forms.clear()
	_layers.clear()
	_layer_stacks.clear()
	_host = null


func root() -> Control:
	return _root


func layer_root(layer: StringName) -> Control:
	return _layers.get(layer, null) as Control


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
	while not stack.is_empty():
		var id: StringName = StringName(stack[-1])
		var form: Variant = get_form(id)
		if form != null and is_instance_valid(form):
			_layer_stacks[layer] = stack
			return form
		stack.pop_back()
		_forms.erase(id)
	_layer_stacks[layer] = stack
	_update_layer_input(layer)
	return null


func close(id: StringName) -> void:
	if not _forms.has(id):
		return
	var form: Variant = _forms.get(id, null)
	if form == null or not is_instance_valid(form):
		_forms.erase(id)
		var affected_screen: bool = false
		for layer_id in _LAYER_ORDER:
			if layer_id == LAYER_SCREEN and _layer_stacks.get(layer_id, []).has(id):
				affected_screen = true
			_remove_from_stack(layer_id, id)
		if affected_screen:
			var previous: Variant = top_form(LAYER_SCREEN)
			if previous:
				previous.visible = true
		return

	var layer: StringName = form.layer()
	form.clear()
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

	var form: Variant = packed_scene.instantiate()
	if form == null:
		push_error("FUI failed to instantiate form '%s'." % String(id))
		return null
	if not is_instance_of(form, FFormScript):
		push_error("FUI can only open scenes whose root extends FForm.")
		if form is Node:
			form.queue_free()
		return null

	form.name = String(id)
	layer_root_node.add_child(form)
	form.assign_runtime(self, layer, id)
	form.setup(context, props)
	if not form.is_setup():
		push_error("FUI form '%s' failed to finish setup." % String(id))
		if form.get_parent():
			form.get_parent().remove_child(form)
		form.queue_free()
		return null

	close(id)
	form.name = String(id)
	if layer == LAYER_HUD or layer == LAYER_TOOLTIP:
		close_layer(layer)
	elif layer == LAYER_SCREEN:
		var previous: Variant = top_form(LAYER_SCREEN)
		if previous:
			previous.visible = false
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
	_update_layer_input(layer)


func _push_to_stack(layer: StringName, id: StringName) -> void:
	var stack: Array = _layer_stacks.get(layer, [])
	stack.append(id)
	_layer_stacks[layer] = stack
	_update_layer_input(layer)


func _remove_from_stack(layer: StringName, id: StringName) -> void:
	var stack: Array = _layer_stacks.get(layer, [])
	var next_stack: Array = []
	for raw_id in stack:
		var stack_id: StringName = StringName(raw_id)
		if stack_id != id:
			next_stack.append(stack_id)
	_layer_stacks[layer] = next_stack
	_update_layer_input(layer)


func _update_layer_input(layer: StringName) -> void:
	if layer != LAYER_MODAL:
		return
	var node: Control = layer_root(layer)
	if node == null:
		return
	var stack: Array = _layer_stacks.get(layer, [])
	node.mouse_filter = Control.MOUSE_FILTER_STOP if not stack.is_empty() else Control.MOUSE_FILTER_IGNORE


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
