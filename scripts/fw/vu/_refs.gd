class_name FRefs
extends RefCounted

var _owner: Node = null
var _paths: Dictionary = {}
var _cache: Dictionary = {}


func setup(owner: Node, source: Variant) -> void:
	_owner = owner
	_paths.clear()
	_cache.clear()
	if source is Dictionary:
		_add_dictionary_refs(source)


func clear() -> void:
	_cache.clear()
	_paths.clear()
	_owner = null


func has_ref(key: StringName) -> bool:
	return _paths.has(key)


func set_ref(key: StringName, raw_path: Variant) -> void:
	if raw_path is NodePath:
		_paths[key] = raw_path
	elif raw_path is String:
		_paths[key] = NodePath(raw_path)
	else:
		push_error("FRefs only accepts NodePath or String values.")
		return
	_cache.erase(key)


func get_ref(key: StringName) -> Node:
	if _cache.has(key):
		var raw_cached: Variant = _cache[key]
		if is_instance_valid(raw_cached) and raw_cached is Node:
			var cached: Node = raw_cached
			return cached
		_cache.erase(key)

	if _owner == null or not is_instance_valid(_owner):
		return null
	if not _paths.has(key):
		return null

	var node: Node = _owner.get_node_or_null(_paths[key])
	if node != null:
		_cache[key] = node
	return node


func require_ref(key: StringName, expected_type: Variant = null) -> Node:
	var node: Node = get_ref(key)
	if node == null:
		push_error("FRefs missing required ref: %s" % String(key))
		return null
	if expected_type != null and not is_instance_of(node, expected_type):
		push_error(
			"FRefs ref '%s' expected %s but got %s"
			% [String(key), str(expected_type), node.get_class()]
		)
		return null
	return node


func _add_dictionary_refs(values: Dictionary) -> void:
	for raw_key in values.keys():
		var key: StringName = StringName(raw_key)
		set_ref(key, values[raw_key])
