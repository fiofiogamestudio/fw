class_name SystemManager
extends RefCounted

var _entries: Array[Dictionary] = []
var _entries_by_id: Dictionary = {}


func add_system(arg0: Variant, arg1: Variant = null, arg2: Variant = null) -> void:
	var id: StringName = &""
	var system = arg0
	var context = arg1

	if typeof(arg0) == TYPE_STRING_NAME or typeof(arg0) == TYPE_STRING:
		id = StringName(arg0)
		system = arg1
		context = arg2
		if id == &"":
			push_error("System id cannot be empty.")
			return
		if _entries_by_id.has(id):
			push_error("Duplicate system id: %s" % id)
			return

	var entry := {
		"id": id,
		"system": system,
		"context": context,
	}
	_entries.append(entry)
	if id != &"":
		_entries_by_id[id] = entry


func remove_system(system: Variant) -> bool:
	for i in range(_entries.size()):
		if _entries[i].system == system:
			var id: StringName = _entries[i].get("id", &"")
			if id != &"":
				_entries_by_id.erase(id)
			_entries.remove_at(i)
			return true
	return false


func get_system(index: int) -> Variant:
	if index < 0 or index >= _entries.size():
		return null
	return _entries[index].system


func has_system(id: StringName) -> bool:
	return _entries_by_id.has(id)


func get_context(id: StringName) -> Variant:
	var entry = _entries_by_id.get(id)
	if entry == null:
		return null
	return entry.context


func bind_refs(graph_refs: Dictionary) -> bool:
	for entry in _entries:
		var entry_id: StringName = entry.get("id", &"")
		if entry_id != &"" and not graph_refs.has(entry_id):
			push_error("System graph missing registered system: %s" % entry_id)
			return false

	for raw_system_id in graph_refs.keys():
		var system_id := StringName(raw_system_id)
		var context = get_context(system_id)
		if context == null:
			push_error("System graph references missing system: %s" % system_id)
			return false
		if not _has_property(context, &"refs") or context.refs == null:
			push_error("System context has no refs: %s" % system_id)
			return false

		var refs: Dictionary = graph_refs[raw_system_id]
		for raw_ref_name in refs.keys():
			var ref_name := StringName(raw_ref_name)
			var target_id := StringName(refs[raw_ref_name])
			var target_context = get_context(target_id)
			if target_context == null:
				push_error("%s.refs.%s references missing system: %s" % [system_id, ref_name, target_id])
				return false
			if not _has_property(context.refs, ref_name):
				push_error("System context %s.refs has no field: %s" % [system_id, ref_name])
				return false
			context.refs.set(ref_name, target_context)

	return true


func init_all() -> void:
	for entry in _entries:
		if entry.system and entry.system.has_method("init"):
			entry.system.init(entry.context)


func tick(dt: float) -> void:
	for entry in _entries:
		if entry.system and entry.system.has_method("tick"):
			entry.system.tick(dt)


func shutdown_all() -> void:
	for i in range(_entries.size() - 1, -1, -1):
		var system = _entries[i].system
		if system and system.has_method("shutdown"):
			system.shutdown()
	_entries.clear()
	_entries_by_id.clear()


func _has_property(obj: Object, property_name: StringName) -> bool:
	if obj == null:
		return false
	for info in obj.get_property_list():
		if StringName(info.name) == property_name:
			return true
	return false
