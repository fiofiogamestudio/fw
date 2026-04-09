class_name BaseMode
extends RefCounted

const SystemManagerScript = preload("_systems.gd")

var _root: Variant
var _context: Variant = null
var _system_manager: Variant


func enter(root: Variant, context: Variant = null) -> void:
	_root = root
	_context = context
	_system_manager = SystemManagerScript.new()


func tick(dt: float) -> void:
	if _system_manager:
		_system_manager.tick(dt)


func handle_input(_event: InputEvent) -> void:
	pass


func exit() -> void:
	if _system_manager:
		_system_manager.shutdown_all()
	_system_manager = null
	_context = null
	_root = null


func add_system(id: StringName, system: Variant, context: Variant = null) -> void:
	if _system_manager == null:
		push_error("Mode system manager is not ready.")
		return
	_system_manager.add_system(id, system, context)


func bind_system_refs(graph_refs: Dictionary) -> bool:
	if _system_manager == null:
		push_error("Mode system manager is not ready.")
		return false
	return _system_manager.bind_refs(graph_refs)


func init_systems() -> void:
	if _system_manager:
		_system_manager.init_all()


func open_form(id: StringName, packed_scene: PackedScene, context: Variant = null) -> Variant:
	return _root.form_manager().open(id, packed_scene, context)


func close_form(id: StringName) -> void:
	_root.form_manager().close(id)


func mode_host() -> Node:
	return _root.mode_host()


func ui_root() -> Node:
	return _root.ui_root()


func pool_manager() -> Variant:
	return _root.pool_manager()


func form_manager() -> Variant:
	return _root.form_manager()
