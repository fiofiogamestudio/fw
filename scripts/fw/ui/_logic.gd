class_name FUiLogic
extends RefCounted

const FBindingScript = preload("_binding.gd")

var _forms: Variant = null
var _form: Variant = null
var _binding: Variant = null


func attach_forms(forms: Variant) -> void:
	_forms = forms


func detach_forms() -> void:
	_forms = null


func open_form(id: StringName, packed_scene: PackedScene, context: Variant = null) -> Variant:
	if _forms == null:
		push_error("FUiLogic requires a valid FormManager.")
		return null
	close_form()
	_form = _forms.open(id, packed_scene, context)
	if _form:
		_binding = _form.create_binding()
	return _form


func close_form() -> void:
	if _binding:
		_binding.unbind()
		_binding = null
	if _forms and _form:
		_forms.close(_form.form_id())
	_form = null


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
		push_error("FUiLogic has no active form.")
		return null
	return _form.require_node(path)


func bind_signal(emitter: Object, signal_name: StringName, callable: Callable, flags: int = 0) -> void:
	if _binding == null:
		_binding = FBindingScript.new()
	_binding.bind_signal(emitter, signal_name, callable, flags)


func bind_vm(vm: Variant, callable: Callable, immediate: bool = true) -> void:
	if _binding == null:
		_binding = FBindingScript.new()
	_binding.bind_vm(vm, callable, immediate)
