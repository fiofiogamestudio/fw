class_name AppRoot
extends Node

const FormManagerScript = preload("../../ui/form/_forms.gd")
const PoolManagerScript = preload("../pool/_pool.gd")

var _mode_host: Node
var _ui_root: CanvasLayer
var _form_manager: RefCounted
var _pool_manager: RefCounted
var _active_mode: Variant = null


func _ready() -> void:
	_mode_host = Node.new()
	_mode_host.name = "ModeHost"
	add_child(_mode_host)

	_ui_root = CanvasLayer.new()
	_ui_root.name = "UIRoot"
	add_child(_ui_root)

	_form_manager = FormManagerScript.new()
	_form_manager.setup(_ui_root)

	_pool_manager = PoolManagerScript.new()
	_pool_manager.setup(_mode_host)

	on_app_ready()


func _physics_process(delta: float) -> void:
	if _active_mode:
		_active_mode.tick(delta)


func _unhandled_input(event: InputEvent) -> void:
	if _active_mode and _active_mode.has_method("handle_input"):
		_active_mode.handle_input(event)


func on_app_ready() -> void:
	pass


func switch_mode(mode: Variant, context: Variant = null) -> Variant:
	if _active_mode:
		_active_mode.exit()
		_active_mode = null
	_form_manager.close_all()
	_pool_manager.clear()
	for child in _mode_host.get_children():
		child.queue_free()

	_active_mode = mode
	_active_mode.enter(self, context)
	return _active_mode


func mode_host() -> Node:
	return _mode_host


func ui_root() -> CanvasLayer:
	return _ui_root


func form_manager() -> Variant:
	return _form_manager


func pool_manager() -> Variant:
	return _pool_manager
