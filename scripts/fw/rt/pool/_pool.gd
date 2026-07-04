class_name FPool
extends RefCounted

var _prefabs: Dictionary = {}
var _free: Dictionary = {}
var _default_parent: Node = null


func setup(default_parent: Node) -> void:
	_default_parent = default_parent


func register_prefab(key: String, packed_scene: PackedScene, warmup: int = 0) -> void:
	if packed_scene == null:
		push_error("FPool cannot register empty prefab for key: %s" % key)
		return

	if _prefabs.has(key) and _prefabs[key] != packed_scene:
		_flush_bucket(key)

	_prefabs[key] = packed_scene
	if not _free.has(key):
		_free[key] = []

	var bucket: Array = _free[key]
	var target_count: int = max(warmup, 0)
	while bucket.size() < target_count:
		bucket.append(_instantiate(key))
	_free[key] = bucket


func spawn(key: String, parent: Node = null) -> Node:
	if not _prefabs.has(key):
		push_error("FPool missing prefab for key: %s" % key)
		return null

	var bucket: Array = _free.get(key, [])
	var node: Node
	if bucket.is_empty():
		node = _instantiate(key)
	else:
		node = bucket.pop_back()

	var target_parent: Node = parent if parent != null else _default_parent
	if target_parent:
		target_parent.add_child(node)
	if node.has_method("setup"):
		node.setup(self)
	return node


func recycle(node: Node) -> void:
	if node == null:
		return
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
	if not _free.has(key):
		_free[key] = []
	_free[key].append(node)


func flush(key: String = "") -> void:
	if key != "":
		_flush_bucket(key)
		return

	for bucket_key in _free.keys():
		_flush_bucket(String(bucket_key))
	_free.clear()
	_prefabs.clear()


func _instantiate(key: String) -> Node:
	var packed_scene: PackedScene = _prefabs[key]
	var node := packed_scene.instantiate()
	node.set_meta("_pool_key", key)
	return node


func _flush_bucket(key: String) -> void:
	var bucket: Array = _free.get(key, [])
	for item in bucket:
		if item and is_instance_valid(item):
			item.queue_free()
	_free.erase(key)
