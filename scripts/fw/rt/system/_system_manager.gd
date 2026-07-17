class_name SystemManager
extends RefCounted

enum LifecycleState {
	CREATED,
	INITIALIZING,
	RUNNING,
	FAULTED,
	STOPPING,
	STOPPED,
}

var _entries: Array[Dictionary] = []
var _entries_by_id: Dictionary = {}
var _initialized_entries: Array[Dictionary] = []
var _phase_order: Array[StringName] = []
var _ordered_cache: Array[Dictionary] = []
var _order_dirty: bool = true
var _state: LifecycleState = LifecycleState.CREATED


func set_phase_order(order: Array) -> void:
	if not _ensure_configurable():
		return
	_phase_order.clear()
	for raw_phase in order:
		var phase := StringName(raw_phase)
		if phase != &"" and not _phase_order.has(phase):
			_phase_order.append(phase)
	_invalidate_order()


func add_system(id: StringName, system: Variant, context: Variant = null, phase: StringName = &"") -> bool:
	if not _ensure_configurable():
		return false
	if id == &"":
		push_error("System id cannot be empty.")
		return false
	if system == null:
		push_error("System '%s' cannot be null." % id)
		return false
	if _entries_by_id.has(id):
		push_error("Duplicate system id: %s" % id)
		return false

	var entry := {
		"id": id,
		"system": system,
		"context": context,
		"phase": phase,
	}
	_entries.append(entry)
	_entries_by_id[id] = entry
	_invalidate_order()
	return true


func remove_system(system: Variant) -> bool:
	if not _ensure_configurable():
		return false
	for i in range(_entries.size()):
		if _entries[i].system == system:
			var id: StringName = _entries[i].get("id", &"")
			if id != &"":
				_entries_by_id.erase(id)
			_entries.remove_at(i)
			_invalidate_order()
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
	if not _ensure_configurable():
		return false
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


func init_all() -> bool:
	if _state != LifecycleState.CREATED:
		push_error("System manager cannot initialize from state: %s" % _state)
		return false
	_state = LifecycleState.INITIALIZING
	for entry in _ordered_entries():
		_initialized_entries.append(entry)
		if entry.system and entry.system.has_method("init"):
			var result: Variant = entry.system.init(entry.context)
			if not (result is bool) or not result:
				push_error("System '%s' init must return true; initialization failed." % entry.get("id", &""))
				_state = LifecycleState.FAULTED
				_shutdown_initialized()
				_clear_registration()
				_state = LifecycleState.STOPPED
				return false
	_state = LifecycleState.RUNNING
	return true


func tick(dt: float) -> void:
	if _state != LifecycleState.RUNNING:
		return
	for entry in _ordered_entries():
		if entry.system and entry.system.has_method("tick"):
			entry.system.tick(dt)


func shutdown_all() -> void:
	if _state == LifecycleState.STOPPED or _state == LifecycleState.STOPPING:
		return
	_state = LifecycleState.STOPPING
	_shutdown_initialized()
	_clear_registration()
	_state = LifecycleState.STOPPED


func is_running() -> bool:
	return _state == LifecycleState.RUNNING


func lifecycle_state() -> LifecycleState:
	return _state


func _shutdown_initialized() -> void:
	for i in range(_initialized_entries.size() - 1, -1, -1):
		var system: Variant = _initialized_entries[i].get("system", null)
		if system and system.has_method("shutdown"):
			system.shutdown()
	_initialized_entries.clear()


func _clear_registration() -> void:
	_entries.clear()
	_entries_by_id.clear()
	_phase_order.clear()
	_ordered_cache.clear()
	_order_dirty = true


func _ensure_configurable() -> bool:
	if _state == LifecycleState.CREATED:
		return true
	push_error("System manager cannot be configured from state: %s" % _state)
	return false


func _ordered_entries() -> Array[Dictionary]:
	if not _order_dirty:
		return _ordered_cache

	if _phase_order.is_empty():
		_ordered_cache = _entries.duplicate()
		_order_dirty = false
		return _ordered_cache

	var out: Array[Dictionary] = []
	var added: Dictionary = {}
	for phase in _phase_order:
		for entry in _entries:
			if StringName(entry.get("phase", &"")) != phase:
				continue
			out.append(entry)
			added[entry.get("id", &"")] = true

	for entry in _entries:
		if added.has(entry.get("id", &"")):
			continue
		out.append(entry)
	_ordered_cache = out
	_order_dirty = false
	return _ordered_cache


func _invalidate_order() -> void:
	_ordered_cache.clear()
	_order_dirty = true


func _has_property(obj: Object, property_name: StringName) -> bool:
	if obj == null:
		return false
	for info in obj.get_property_list():
		if StringName(info.name) == property_name:
			return true
	return false
