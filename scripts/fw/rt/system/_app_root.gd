class_name AppRoot
extends Node

const FPoolScript = preload("../pool/_pool.gd")
const FAssetScript = preload("../_asset.gd")
const FUIScript = preload("../../vu/ui/_ui.gd")

var _mode_host: Node
var _pool: RefCounted
var _asset: RefCounted
var _ui_root: CanvasLayer
var _ui: RefCounted
var _active_mode: Variant = null
var _is_switching_mode: bool = false


func _ready() -> void:
	_mode_host = Node.new()
	_mode_host.name = "ModeHost"
	add_child(_mode_host)

	_pool = FPoolScript.new()
	_pool.setup(_mode_host)
	_asset = FAssetScript.new()

	_ui_root = CanvasLayer.new()
	_ui_root.name = "UIRoot"
	add_child(_ui_root)

	_ui = FUIScript.new()
	_ui.setup(_ui_root)

	on_app_ready()


func _exit_tree() -> void:
	if _active_mode:
		_active_mode.exit()
	_active_mode = null
	if _ui:
		_ui.clear()
	if _pool:
		_pool.flush()
	if _asset:
		_asset.unload()
	_ui = null
	_pool = null
	_asset = null


func _physics_process(dt: float) -> void:
	if _active_mode:
		_active_mode.tick(dt)


func _unhandled_input(event: InputEvent) -> void:
	if _active_mode and _active_mode.has_method("handle_input"):
		_active_mode.handle_input(event)


func on_app_ready() -> void:
	pass


func switch_mode(mode: Variant, context: Variant = null) -> Variant:
	if _is_switching_mode:
		push_error("AppRoot rejected a reentrant mode switch.")
		return _active_mode
	if not _is_valid_mode(mode):
		push_error("AppRoot requires a mode with enter/tick/exit methods.")
		return _active_mode

	_is_switching_mode = true
	if _active_mode:
		_active_mode.exit()
		_active_mode = null
	_ui.close_all()
	_pool.flush()
	_clear_mode_host()

	var entered: Variant = mode.enter(self, context)
	if not (entered is bool and entered):
		if mode.has_method("exit"):
			mode.exit()
		_ui.close_all()
		_pool.flush()
		_clear_mode_host()
		_is_switching_mode = false
		on_mode_switch_failed(mode)
		return null
	_active_mode = mode
	_is_switching_mode = false
	return _active_mode


func on_mode_switch_failed(_mode: Variant) -> void:
	pass


func _is_valid_mode(mode: Variant) -> bool:
	return mode != null and mode.has_method("enter") and mode.has_method("tick") and mode.has_method("exit")


func _clear_mode_host() -> void:
	for child in _mode_host.get_children():
		if child.is_queued_for_deletion():
			continue
		_mode_host.remove_child(child)
		child.queue_free()


func mode_host() -> Node:
	return _mode_host


func pool() -> Variant:
	return _pool


func asset() -> Variant:
	return _asset


func ui_root() -> CanvasLayer:
	return _ui_root


func ui() -> Variant:
	return _ui
