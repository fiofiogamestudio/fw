class_name GameLogic
extends "res://fw/scripts/fw/vu/ui/form/_form_logic.gd"

const FORM_ID: StringName = &"game_form"
const FViewModelScript = preload("res://fw/scripts/fw/vu/ui/_view_model.gd")

var _context: Variant = null
var _system: Variant = null
var _view_model_state: Variant = null
var _title_label: Label = null
var _subtitle_label: Label = null
var _status_label: Label = null
var _counter_label: Label = null
var _refresh_button: Button = null


func enter(form_scene: PackedScene, context: Variant, system: Variant) -> void:
	_context = context
	_system = system
	var opened_form = open(FUIScript.LAYER_SCREEN, FORM_ID, form_scene, context)
	if opened_form == null:
		return

	_title_label = require_ref(&"title_label", Label) as Label
	_subtitle_label = require_ref(&"subtitle_label", Label) as Label
	_status_label = require_ref(&"status_label", Label) as Label
	_counter_label = require_ref(&"counter_label", Label) as Label

	_refresh_button = require_ref(&"refresh_button", Button) as Button
	if _refresh_button:
		bind_signal(_refresh_button, &"pressed", Callable(self, "_on_refresh_pressed"))

	_view_model_state = FViewModelScript.new()
	set_view_model(_view_model_state)
	bind_view_model(_view_model_state, Callable(self, "_on_view_model_changed"))
	_sync_view_model()


func tick(_dt: float) -> void:
	_sync_view_model()


func exit() -> void:
	close()
	detach_ui()
	_context = null
	_system = null
	_view_model_state = null
	_title_label = null
	_subtitle_label = null
	_status_label = null
	_counter_label = null
	_refresh_button = null


func _on_refresh_pressed() -> void:
	if _system and _system.has_method("increment_press_count"):
		_system.increment_press_count()
	_sync_view_model()


func _sync_view_model() -> void:
	if _context == null:
		return
	if _view_model_state == null:
		return
	var press_count: int = 0
	if _system and _system.has_method("get_press_count"):
		press_count = int(_system.get_press_count())
	_view_model_state.set_value(&"title_text", _context.config.project_name)
	_view_model_state.set_value(&"subtitle_text", _context.config.subtitle)
	_view_model_state.set_value(&"status_text", _context.config.status_message)
	_view_model_state.set_value(
		&"counter_text",
		"Button pressed: %d" % press_count
	)


func _on_view_model_changed(_key: StringName) -> void:
	if _view_model_state == null:
		return
	if _title_label:
		_title_label.text = str(_view_model_state.get_value(&"title_text", ""))
	if _subtitle_label:
		_subtitle_label.text = str(_view_model_state.get_value(&"subtitle_text", ""))
	if _status_label:
		_status_label.text = str(_view_model_state.get_value(&"status_text", ""))
	if _counter_label:
		_counter_label.text = str(_view_model_state.get_value(&"counter_text", ""))
