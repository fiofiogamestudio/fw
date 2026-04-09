extends "res://fw/scripts/fw/rt/system/_root.gd"

const GameModeScript = preload("res://scripts/app/game_mode.gd")
const GameModeContextScript = preload("res://scripts/app/game_mode_context.gd")


func on_app_ready() -> void:
	var context = GameModeContextScript.new()
	context.config.project_name = "__PROJECT_NAME_PASCAL__"
	context.config.subtitle = "Fw New Scaffold"
	context.config.status_message = "当前项目已经接上 fw。"
	switch_mode(GameModeScript.new(), context)
