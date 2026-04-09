class_name FormManager
extends RefCounted

var _host: Node = null
var _forms: Dictionary = {}


func setup(host: Node) -> void:
	_host = host


func open(id: StringName, packed_scene: PackedScene, context: Variant = null) -> Variant:
	if _host == null:
		push_error("FormManager host is not ready.")
		return null
	if packed_scene == null:
		push_error("FormManager cannot open an empty form prefab.")
		return null

	close(id)

	var form = packed_scene.instantiate()
	if form == null:
		push_error("FormManager can only open scenes whose root extends FForm.")
		return null
	form.name = String(id)
	_host.add_child(form)
	form.assign_form_id(id)
	if form.has_method("init"):
		form.init(context)
	_forms[id] = form
	return form


func has(id: StringName) -> bool:
	return _forms.has(id)


func get_form(id: StringName) -> Variant:
	return _forms.get(id, null)


func close(id: StringName) -> void:
	var form = _forms.get(id, null)
	if form == null:
		return
	if form.has_method("shutdown"):
		form.shutdown()
	if is_instance_valid(form):
		form.queue_free()
	_forms.erase(id)


func close_all() -> void:
	var ids: Array = _forms.keys()
	for i in range(ids.size() - 1, -1, -1):
		close(StringName(ids[i]))
