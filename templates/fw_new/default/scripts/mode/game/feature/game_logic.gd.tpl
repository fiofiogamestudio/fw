class_name GameLogic
extends "res://fw/scripts/fw/ui/_ui_logic.gd"

const FORM_ID: StringName = &"game_form"

var _context: Variant = null
var _system: Variant = null
var _title_label: Label = null
var _subtitle_label: Label = null
var _status_label: Label = null
var _counter_label: Label = null


func enter(form_scene: PackedScene, context: Variant, system: Variant) -> void:
	_context = context
	_system = system
	var opened_form = open_form(FORM_ID, form_scene, context)
	if opened_form == null:
		return

	_title_label = require_node(^"Center/Panel/Margin/VBox/TitleLabel") as Label
	_subtitle_label = require_node(^"Center/Panel/Margin/VBox/SubtitleLabel") as Label
	_status_label = require_node(^"Center/Panel/Margin/VBox/StatusLabel") as Label
	_counter_label = require_node(^"Center/Panel/Margin/VBox/CounterLabel") as Label

	var refresh_button = require_node(^"Center/Panel/Margin/VBox/RefreshButton") as Button
	if refresh_button:
		bind_signal(refresh_button, &"pressed", Callable(self, "_on_refresh_pressed"))

	_apply()


func tick(_dt: float) -> void:
	_apply()


func exit() -> void:
	close_form()
	detach_forms()
	_context = null
	_system = null
	_title_label = null
	_subtitle_label = null
	_status_label = null
	_counter_label = null


func _on_refresh_pressed() -> void:
	if _system and _system.has_method("increment_press_count"):
		_system.increment_press_count()
	_apply()


func _apply() -> void:
	if _context == null:
		return
	if _title_label:
		_title_label.text = _context.config.project_name
	if _subtitle_label:
		_subtitle_label.text = _context.config.subtitle
	if _status_label:
		_status_label.text = _context.config.status_message
	if _counter_label:
		var press_count: int = 0
		if _system and _system.has_method("get_press_count"):
			press_count = int(_system.get_press_count())
		_counter_label.text = "Button pressed: %d" % press_count
