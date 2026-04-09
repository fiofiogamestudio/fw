class_name FViewModel
extends RefCounted

signal changed(key: String)

var _values: Dictionary = {}


func set_value(key: StringName, value: Variant) -> void:
	if _values.has(key) and _values[key] == value:
		return
	_values[key] = value
	notify_changed(String(key))


func get_value(key: StringName, fallback: Variant = null) -> Variant:
	return _values.get(key, fallback)


func assign(values: Dictionary) -> void:
	for raw_key in values.keys():
		set_value(StringName(raw_key), values[raw_key])


func clear_values() -> void:
	if _values.is_empty():
		return
	_values.clear()
	notify_changed("")


func notify_changed(key: String) -> void:
	changed.emit(key)
