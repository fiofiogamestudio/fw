class_name GameLogic
extends "res://fw/scripts/fw/ui/_ui_logic.gd"

const FORM_ID: StringName = &"game_form"

var _title_label: Label = null
var _subtitle_label: Label = null
var _status_label: Label = null
var _counter_label: Label = null
var _press_count: int = 0


func enter(form_scene: PackedScene, context: Variant) -> void:
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

	_apply(context)


func exit() -> void:
	close_form()
	detach_forms()
	_title_label = null
	_subtitle_label = null
	_status_label = null
	_counter_label = null


func _on_refresh_pressed() -> void:
	_press_count += 1
	if _counter_label:
		_counter_label.text = "Button pressed: %d" % _press_count


func _apply(context: Variant) -> void:
	if _title_label:
		_title_label.text = context.config.project_name
	if _subtitle_label:
		_subtitle_label.text = context.config.subtitle
	if _status_label:
		_status_label.text = context.config.status_message
	if _counter_label:
		_counter_label.text = "Button pressed: %d" % _press_count
