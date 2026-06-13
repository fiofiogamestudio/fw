class_name FFormLogic
extends RefCounted

const FBindingScript = preload("../../_binding.gd")
const FUIScript = preload("../_ui.gd")

var _ui: Variant = null
var _form: Variant = null
var _binding: Variant = null
var _view_model: Variant = null


func attach_ui(ui: Variant) -> void:
	_ui = ui


func detach_ui() -> void:
	_ui = null


func open(
	layer: StringName,
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	if _ui == null:
		push_error("FFormLogic requires a valid FUI.")
		return null
	close()
	_form = _ui.open(layer, id, packed_scene, context, props)
	if _form:
		_binding = _form.create_binding()
	return _form


func close() -> void:
	if _binding:
		_binding.unbind()
		_binding = null
	if _ui and _form:
		_ui.close(_form.form_id())
	_form = null
	_view_model = null


func form() -> Variant:
	return _form


func binding() -> Variant:
	return _binding


func ui_event() -> Variant:
	if _form == null:
		return null
	return _form.ui_event()


func require_node(path: NodePath) -> Node:
	if _form == null:
		push_error("FFormLogic has no active form.")
		return null
	return _form.require_node(path)


func get_ref(key: StringName) -> Node:
	if _form == null:
		push_error("FFormLogic has no active form.")
		return null
	return _form.get_ref(key)


func require_ref(key: StringName, expected_type: Variant = null) -> Node:
	if _form == null:
		push_error("FFormLogic has no active form.")
		return null
	return _form.require_ref(key, expected_type)


func has_prop(key: StringName) -> bool:
	return _form != null and _form.has_prop(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	if _form == null:
		return fallback
	return _form.get_prop(key, fallback)


func apply_props(props: Dictionary) -> void:
	if _form:
		_form.apply_props(props)


func resolved_props() -> Dictionary:
	if _form == null:
		return {}
	return _form.resolved_props()


func bind_signal(emitter: Object, signal_name: StringName, callable: Callable, flags: int = 0) -> void:
	if _binding == null:
		_binding = FBindingScript.new()
	_binding.bind_signal(emitter, signal_name, callable, flags)


func bind_vm(vm: Variant, callable: Callable, immediate: bool = true) -> void:
	bind_view_model(vm, callable, immediate)


func bind_view_model(vm: Variant, callable: Callable, immediate: bool = true) -> void:
	if _binding == null:
		_binding = FBindingScript.new()
	_binding.bind_view_model(vm, callable, immediate)


func set_view_model(vm: Variant) -> void:
	_view_model = vm


func view_model() -> Variant:
	return _view_model


func ui() -> Variant:
	return _ui
