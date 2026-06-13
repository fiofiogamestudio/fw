class_name AssetLoader
extends RefCounted

var _cache: Dictionary = {}


func load(path: String) -> Resource:
	if not _cache.has(path):
		_cache[path] = ResourceLoader.load(path)
	return _cache[path]


func unload(path: String = "") -> void:
	if path == "":
		_cache.clear()
		return
	_cache.erase(path)
