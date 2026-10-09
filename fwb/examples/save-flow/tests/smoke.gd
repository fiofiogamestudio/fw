extends SceneTree

var failures := 0
var checks := 0

func _initialize() -> void:
	_run.call_deferred()

func check(condition: bool, message: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		push_error(message)

func _run() -> void:
	var game: Control = load("res://main.tscn").instantiate()
	game.save_path = "user://counter-smoke.json"
	var adapter = load("res://addons/fwb/adapters/file_save_adapter.gd").new()
	adapter.setup(game.save_path, game._validate, game._new_save, 4096)
	check(adapter.create_new_save().get("ok", false), "test local seed created through safe adapter")
	root.add_child(game)
	var platform: Node = root.get_node("FwbPlatform")
	var button: Button
	for index in 120:
		await process_frame
		button = platform.find_child("ContinueLocal", true, false)
		if button != null and not button.disabled:
			break
	check(button != null and not button.disabled, "real startup picker has a usable local action")
	if button == null or button.disabled:
		quit(1)
		return
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture=") and DisplayServer.get_name() != "headless":
			await process_frame
			await RenderingServer.frame_post_draw
			check(root.get_texture().get_image().save_png(argument.trim_prefix("--capture=")) == OK, "native startup capture saved")
	button.pressed.emit()
	for index in 120:
		await process_frame
		if game.started:
			break
	check(game.started and game.counter == 0, "picker completes before gameplay starts")
	game._advance()
	check(game.counter == 1 and adapter.get_local_snapshot().valid, "game writes then commits its counter")
	var before: PackedByteArray = adapter.get_local_snapshot().bytes
	check(not game._commit(-1) and game.counter == 1 and adapter.get_local_snapshot().bytes == before, "invalid state does not change model or local master")
	platform.set_pause_reason("smoke", true)
	game._advance()
	check(game.counter == 1, "platform interruption blocks gameplay input")
	platform.set_pause_reason("smoke", false)
	game._advance()
	check(game.counter == 2, "gameplay input resumes")
	await game._rewarded()
	check(game.counter == 2 and game._grants.is_empty(), "missing native ad provider never grants a fake reward")
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture=") and DisplayServer.get_name() != "headless":
			await process_frame
			await RenderingServer.frame_post_draw
			var path := argument.trim_prefix("--capture=").trim_suffix(".png") + "-game.png"
			check(root.get_texture().get_image().save_png(path) == OK, "native gameplay capture saved")
	game.queue_free()
	await process_frame
	print("FWB_SAVE_FLOW_EXAMPLE checks=%d failures=%d" % [checks, failures])
	quit(0 if failures == 0 else 1)
