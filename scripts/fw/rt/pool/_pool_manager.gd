class_name PoolManager
extends RefCounted

var _scenes: Dictionary = {}
var _free: Dictionary = {}
var _default_parent: Node = null


func setup(default_parent: Node) -> void:
	_default_parent = default_parent


func register_scene(key: String, packed_scene: PackedScene, warmup: int = 0) -> void:
	_scenes[key] = packed_scene
	if not _free.has(key):
		_free[key] = []
	for _i in range(warmup):
		var node := _instantiate(key)
		_free[key].append(node)


func spawn(key: String, parent: Node = null) -> Node:
	if not _scenes.has(key):
		push_error("PoolManager missing scene for key: %s" % key)
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
	return node


func recycle(node: Node) -> void:
	if node == null:
		return
	if not node.has_meta("_pool_key"):
		node.queue_free()
		return

	var key: String = String(node.get_meta("_pool_key"))
	if node.get_parent():
		node.get_parent().remove_child(node)
	if not _free.has(key):
		_free[key] = []
	_free[key].append(node)


func clear(key: String = "") -> void:
	if key != "":
		_clear_bucket(key)
		return

	for bucket_key in _free.keys():
		_clear_bucket(String(bucket_key))
	_free.clear()


func _instantiate(key: String) -> Node:
	var packed_scene: PackedScene = _scenes[key]
	var node := packed_scene.instantiate()
	node.set_meta("_pool_key", key)
	return node


func _clear_bucket(key: String) -> void:
	var bucket: Array = _free.get(key, [])
	for item in bucket:
		if item and is_instance_valid(item):
			item.queue_free()
	_free.erase(key)
