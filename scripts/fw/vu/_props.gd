class_name FProps
extends RefCounted

var _defaults: Dictionary = {}
var _overrides: Dictionary = {}


func setup(defaults: Variant, overrides: Dictionary = {}) -> void:
	_defaults = _normalize(defaults)
	_overrides = _normalize(overrides)


func clear() -> void:
	_defaults.clear()
	_overrides.clear()


func has_prop(key: StringName) -> bool:
	return _overrides.has(key) or _defaults.has(key)


func get_prop(key: StringName, fallback: Variant = null) -> Variant:
	if _overrides.has(key):
		return _overrides[key]
	if _defaults.has(key):
		return _defaults[key]
	return fallback


func set_prop(key: StringName, value: Variant) -> void:
	_overrides[key] = value


func apply_props(overrides: Dictionary) -> void:
	for raw_key in overrides.keys():
		var key: StringName = StringName(raw_key)
		_overrides[key] = overrides[raw_key]


func resolved_props() -> Dictionary:
	var resolved: Dictionary = _defaults.duplicate(true)
	for raw_key in _overrides.keys():
		resolved[raw_key] = _overrides[raw_key]
	return resolved


func _normalize(values: Variant) -> Dictionary:
	var normalized: Dictionary = {}
	if values is Dictionary:
		for raw_key in values.keys():
			var key: StringName = StringName(raw_key)
			normalized[key] = values[raw_key]
	return normalized
