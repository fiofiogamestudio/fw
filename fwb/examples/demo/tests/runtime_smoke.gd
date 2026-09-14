extends SceneTree


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var platform := root.get_node("FwbPlatform")
	var capabilities: Dictionary = await platform.initialize()
	assert(capabilities["platform"] == "web")
	assert(not capabilities["rewarded_ads"])
	var unavailable: Dictionary = await platform.request_rewarded_ad()
	assert(unavailable["status"] == "unavailable")
	assert(not unavailable["reward_eligible"])
	var scene: PackedScene = load("res://main.tscn")
	var game := scene.instantiate()
	root.add_child(game)
	await process_frame
	await process_frame
	print("FWB_DEMO_LAYOUT ", game.get_child(1).get_combined_minimum_size(), " viewport=", root.size)
	assert(game.get_child(1).get_combined_minimum_size().y <= 740)
	game._reset()
	for index in range(14):
		game._collect()
	# Let the audio mixer consume the synthetic rapid input before destroying it.
	await create_timer(0.2).timeout
	assert(game.energy == 2)
	assert(game.deliveries == 1)
	assert(game.collected == 14)
	await game._try_ad()
	assert(game.energy == 2)
	assert(game.reward_count == 0)
	game.queue_free()
	await process_frame
	var restored := scene.instantiate()
	root.add_child(restored)
	await process_frame
	assert(restored.energy == 2)
	assert(restored.deliveries == 1)
	assert(restored.collected == 14)
	assert(restored.config["mission_energy"] == 12)
	print("FWB_RUNTIME_SMOKE_OK config=true saved_energy=2 restored_energy=2 deliveries=1 unavailable_ad_no_reward=true")
	restored._reset()
	restored.queue_free()
	await process_frame
	quit(0)
