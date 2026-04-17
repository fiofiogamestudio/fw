class_name FUIEvent
extends RefCounted

signal emitted(kind: StringName, payload: Variant)

var _listeners: Dictionary = {}


func on(kind: StringName, callable: Callable) -> void:
	if not callable.is_valid():
		return
	var bucket: Array = _listeners.get(kind, [])
	if bucket.any(func(item: Callable) -> bool: return item == callable):
		return
	bucket.append(callable)
	_listeners[kind] = bucket


func off(kind: StringName, callable: Callable) -> void:
	var bucket: Array = _listeners.get(kind, [])
	for index in range(bucket.size() - 1, -1, -1):
		if bucket[index] == callable:
			bucket.remove_at(index)
	if bucket.is_empty():
		_listeners.erase(kind)
	else:
		_listeners[kind] = bucket


func emit_event(kind: StringName, payload: Variant = null) -> void:
	emitted.emit(kind, payload)
	var bucket: Array = _listeners.get(kind, [])
	for callable in bucket:
		if callable.is_valid():
			callable.call(payload)


func clear() -> void:
	_listeners.clear()
