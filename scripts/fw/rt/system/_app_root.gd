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


func _physics_process(dt: float) -> void:
	if _active_mode:
		_active_mode.tick(dt)


func _input(event: InputEvent) -> void:
	if _active_mode and _active_mode.has_method("handle_input"):
		_active_mode.handle_input(event)


func on_app_ready() -> void:
	pass


func switch_mode(mode: Variant, context: Variant = null) -> Variant:
	if _active_mode:
		_active_mode.exit()
		_active_mode = null
	_ui.close_all()
	_pool.flush()
	for child in _mode_host.get_children():
		child.queue_free()

	_active_mode = mode
	_active_mode.enter(self, context)
	return _active_mode


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
