class_name FForms
extends RefCounted

const FUIScript = preload("../_ui.gd")

var _host: CanvasLayer = null
var _ui: Variant = null


func setup(host: CanvasLayer) -> void:
	_host = host
	_ui = FUIScript.new()
	_ui.setup(host)


func open(
	id: StringName,
	packed_scene: PackedScene,
	context: Variant = null,
	props: Dictionary = {}
) -> Variant:
	if _ui == null:
		push_error("FForms host is not ready.")
		return null
	return _ui.push_screen(id, packed_scene, context, props)


func has(id: StringName) -> bool:
	return _ui != null and _ui.has(id)


func get_form(id: StringName) -> Variant:
	if _ui == null:
		return null
	return _ui.get_form(id)


func close(id: StringName) -> void:
	if _ui == null:
		return
	_ui.close(id)


func close_all() -> void:
	if _ui:
		_ui.close_all()


func ui() -> Variant:
	return _ui
