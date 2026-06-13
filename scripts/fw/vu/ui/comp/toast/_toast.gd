@tool
class_name FToast
extends "res://fw/scripts/fw/vu/ui/form/_form.gd"

@export var duration_seconds: float = 2.0

var _dismiss_timer: SceneTreeTimer = null


func on_setup() -> void:
	if duration_seconds > 0.0:
		_dismiss_timer = get_tree().create_timer(duration_seconds)
		_dismiss_timer.timeout.connect(_on_timeout)


func on_clear() -> void:
	_dismiss_timer = null


func _on_timeout() -> void:
	if ui():
		ui().close(form_id())
