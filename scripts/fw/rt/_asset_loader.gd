class_name AssetLoader
extends RefCounted

var _cache: Dictionary = {}


func load_cached(path: String) -> Resource:
	if not _cache.has(path):
		_cache[path] = load(path)
	return _cache[path]


func clear(path: String = "") -> void:
	if path == "":
		_cache.clear()
		return
	_cache.erase(path)
