class_name FPool
extends RefCounted

var _prefabs: Dictionary = {}
var _generations: Dictionary = {}
var _free: Dictionary = {}
var _active: Dictionary = {}
var _default_parent: Node = null


func setup(default_parent: Node) -> void:
	_default_parent = default_parent


func register_prefab(key: String, packed_scene: PackedScene, warmup: int = 0) -> void:
	if key.is_empty():
		push_error("FPool prefab key cannot be empty.")
		return
	if packed_scene == null:
		push_error("FPool cannot register empty prefab for key: %s" % key)
		return

	var changed: bool = not _prefabs.has(key) or _prefabs[key] != packed_scene
	if changed and _prefabs.has(key):
		_flush_bucket(key)
	_generations[key] = int(_generations.get(key, 0)) + (1 if changed else 0)

	_prefabs[key] = packed_scene
	if not _free.has(key):
		_free[key] = []

	var bucket: Array = _free[key]
	var target_count: int = max(warmup, 0)
	while bucket.size() < target_count:
		var node: Node = _instantiate(key)
		if node == null:
			break
		bucket.append(node)
	_free[key] = bucket


func spawn(
	key: String,
	parent: Node = null,
	owner: Variant = null,
	props: Dictionary = {}
) -> Node:
	if not _prefabs.has(key):
		push_error("FPool missing prefab for key: %s" % key)
		return null

	var bucket: Array = _free.get(key, [])
	var node: Node = _take_free_node(key, bucket)
	if node == null:
		node = _instantiate(key)
		if node == null:
			return null
	_free[key] = bucket

	var target_parent: Node = parent if parent != null else _default_parent
	if target_parent != null:
		if not is_instance_valid(target_parent):
			push_error("FPool cannot spawn '%s' under an invalid parent." % key)
			bucket.append(node)
			_free[key] = bucket
			return null
		target_parent.add_child(node)
	_active[node.get_instance_id()] = node
	if node.has_method("setup"):
		node.setup(owner, props)
	return node


func recycle(node: Node) -> void:
	if node == null or not is_instance_valid(node):
		return
	var instance_id: int = node.get_instance_id()
	if not _active.has(instance_id) or _active[instance_id] != node:
		push_warning("FPool ignored recycle for a node that is not active.")
		return
	_active.erase(instance_id)
	if not node.has_meta("_pool_key"):
		if node.has_method("clear"):
			node.clear()
		node.queue_free()
		return

	var key: String = String(node.get_meta("_pool_key"))
	if node.has_method("clear"):
		node.clear()
	if node.get_parent():
		node.get_parent().remove_child(node)
	var node_generation: int = int(node.get_meta("_pool_generation", 0))
	var current_generation: int = int(_generations.get(key, 0))
	if not _prefabs.has(key) or node_generation != current_generation:
		if not node.is_queued_for_deletion():
			node.queue_free()
		return
	if not _free.has(key):
		_free[key] = []
	_free[key].append(node)


func flush(key: String = "") -> void:
	if key != "":
		_flush_active(key)
		_flush_bucket(key)
		return

	_flush_active()
	for bucket_key in _free.keys():
		_flush_bucket(String(bucket_key))
	_free.clear()
	_active.clear()
	_prefabs.clear()
	_generations.clear()


func _instantiate(key: String) -> Node:
	var packed_scene: PackedScene = _prefabs[key]
	var node: Node = packed_scene.instantiate()
	if node == null:
		push_error("FPool failed to instantiate prefab: %s" % key)
		return null
	node.set_meta("_pool_key", key)
	node.set_meta("_pool_generation", int(_generations.get(key, 0)))
	return node


func _take_free_node(key: String, bucket: Array) -> Node:
	var generation: int = int(_generations.get(key, 0))
	while not bucket.is_empty():
		var candidate: Variant = bucket.pop_back()
		if candidate == null or not is_instance_valid(candidate):
			continue
		var node: Node = candidate
		if node.is_queued_for_deletion():
			continue
		if String(node.get_meta("_pool_key", "")) != key:
			node.queue_free()
			continue
		if int(node.get_meta("_pool_generation", 0)) != generation:
			node.queue_free()
			continue
		if _active.has(node.get_instance_id()):
			push_warning("FPool discarded a free bucket entry that is still active.")
			continue
		return node
	return null


func _flush_bucket(key: String) -> void:
	var bucket: Array = _free.get(key, [])
	for item in bucket:
		if item and is_instance_valid(item):
			item.queue_free()
	_free.erase(key)


func _flush_active(key: String = "") -> void:
	for raw_id in _active.keys():
		var raw_node: Variant = _active[raw_id]
		if not is_instance_valid(raw_node) or not (raw_node is Node):
			_active.erase(raw_id)
			continue
		var node: Node = raw_node
		if key != "" and String(node.get_meta("_pool_key", "")) != key:
			continue
		if node.has_method("clear"):
			node.clear()
		if not node.is_queued_for_deletion():
			node.queue_free()
		_active.erase(raw_id)
