extends "res://fw/scripts/fw/rt/system/_app_root.gd"

const GameModeScript = preload("res://scripts/mode/game/game_mode.gd")
const GameContextScript = preload("res://scripts/mode/game/game_context.gd")
const Config = preload("res://scripts/_gen/_config.gd")


func on_app_ready() -> void:
	var context: Variant = GameContextScript.new()
	var game_config: Dictionary = Config.game_default_config()
	context.config.project_name = str(game_config.get("title", "__PROJECT_NAME_PASCAL__"))
	context.config.subtitle = "Fw New Scaffold"
	context.config.status_message = "Project is now wired to fw."
	switch_mode(GameModeScript.new(), context)
