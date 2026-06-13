class_name BaseMode
extends RefCounted

const SystemManagerScript = preload("_system_manager.gd")

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


func add_system(id: StringName, system: Variant, context: Variant = null, phase: StringName = &"") -> void:
	if _system_manager == null:
		push_error("Mode system manager is not ready.")
		return
	_system_manager.add_system(id, system, context, phase)


func set_system_phase_order(order: Array) -> void:
	if _system_manager == null:
		push_error("Mode system manager is not ready.")
		return
	_system_manager.set_phase_order(order)


func bind_system_refs(refs: Dictionary) -> bool:
	if _system_manager == null:
		push_error("Mode system manager is not ready.")
		return false
	return _system_manager.bind_refs(refs)


func init_systems() -> void:
	if _system_manager:
		_system_manager.init_all()


func mode_host() -> Node:
	return _root.mode_host()


func ui_root() -> Node:
	return _root.ui_root()


func pool_manager() -> Variant:
	return _root.pool_manager()


func ui() -> Variant:
	return _root.ui()
