extends SceneTree

const SaveService = preload("res://addons/fwb/services/save_service.gd")
const AdsService = preload("res://addons/fwb/services/ads_service.gd")
const PlatformService = preload("res://addons/fwb/platform.gd")

class ClockedSave extends SaveService:
	var clock_now := 100.0
	func _now() -> float:
		return clock_now

class Adapter extends RefCounted:
	var bytes := "save:local".to_utf8_buffer()
	var imports := 0
	var creates := 0
	var fail_import := false
	func get_local_snapshot() -> Dictionary:
		return {"exists": not bytes.is_empty(), "valid": not bytes.is_empty(), "bytes": bytes, "summary": "Example save", "updated_at": 100, "playtime": 20}
	func validate_save(data: PackedByteArray) -> Dictionary:
		return {"ok": data.get_string_from_utf8().begins_with("save:")}
	func import_save(data: PackedByteArray) -> Dictionary:
		if fail_import:
			return {"ok": false, "message": "disk failure"}
		bytes = data
		imports += 1
		return {"ok": true, "path": "user://test.json"}
	func create_new_save() -> Dictionary:
		creates += 1
		bytes = "save:new".to_utf8_buffer()
		return {"ok": true, "path": "user://test.json"}

class Provider extends Node:
	signal lifecycle_changed(event: String)
	var available := true
	var rows: Array = []
	var data := PackedByteArray()
	var writes: Array = []
	var reports: Array = []
	var fail_write := false
	var fail_list := false
	var pending_frames := 0
	var stop_on_list: Object
	var ad_result := {"status": "success", "reward_eligible": true, "simulated": false, "request_id": "1"}
	var ads := 0
	func initialize() -> Dictionary:
		return capabilities()
	func capabilities() -> Dictionary:
		return {"cloud_save": available}
	func list_cloud_archives() -> Dictionary:
		for i in pending_frames:
			await get_tree().process_frame
		if is_instance_valid(stop_on_list):
			stop_on_list.stop()
			stop_on_list = null
		return {"status": "error", "message": "offline"} if fail_list else {"status": "success", "archives": rows.duplicate(true)}
	func read_cloud_bytes(_uuid: String, _file: String) -> Dictionary:
		for i in pending_frames:
			await get_tree().process_frame
		return {"status": "success", "data": data}
	func write_cloud_bytes(bytes: PackedByteArray, metadata: Dictionary, uuid: String) -> Dictionary:
		writes.append({"bytes": bytes, "metadata": metadata, "uuid": uuid})
		if fail_write:
			return {"status": "error", "remote_outcome": "unknown", "message": "timeout"}
		return {"status": "success", "archive_uuid": "new-id" if uuid.is_empty() else uuid, "file_id": "file-next"}
	func report_file_written(path: String) -> void:
		reports.append(path)
	func request_rewarded_ad() -> Dictionary:
		ads += 1
		await get_tree().process_frame
		return ad_result.duplicate(true)
	func request_commercial_ad() -> Dictionary:
		ads += 1
		return ad_result.duplicate(true)

var failures := 0
var checks := 0
var async_result: Dictionary = {}

func _initialize() -> void:
	_run.call_deferred()

func check(value: bool, message: String) -> void:
	checks += 1
	if not value:
		failures += 1
		push_error(message)

func service(provider: Provider, adapter: Adapter, options: Dictionary = {}) -> Node:
	var result := SaveService.new()
	var settings := {"gameId": "test.game", "autoUpload": true, "debounceSeconds": 1.0}
	settings.merge(options, true)
	result.setup(provider, adapter, settings)
	root.add_child(result)
	return result

func cloud_row(save: Node, id: String = "cloud-a") -> Dictionary:
	return {"archive_uuid": id, "file_id": "file-a", "name": save._archive_name(), "summary": "Remote",
		"extra": JSON.stringify({"fwb": 1, "game_id": "test.game", "slot": "main"}), "updated_at": 200, "playtime": 30}

func cloud_bytes(save: Node, content: String = "save:remote") -> PackedByteArray:
	return save._encode_envelope(content.to_utf8_buffer(), {"summary": "Remote", "updated_at": 200, "playtime": 30}).data

func choose_later(save: Node) -> void:
	async_result = await save.choose_cloud("cloud-a", true)

func refresh_later(save: Node) -> void:
	async_result = await save.refresh()

func complete_picker(platform: Node) -> void:
	for i in 4:
		await process_frame
	for child in platform.get_children():
		if child is CanvasLayer:
			check(child.layer >= 100, "startup picker draws above the host's later main-scene background")
			for screen in child.get_children():
				if screen is Control and screen.has_signal("completed"):
					screen.completed.emit(screen._service.choose_local())

func _run() -> void:
	var provider := Provider.new()
	root.add_child(provider)
	var adapter := Adapter.new()
	var save := service(provider, adapter)
	provider.rows = [cloud_row(save), {"archive_uuid": "other", "file_id": "f", "name": "other-game", "extra": "{}"}]
	provider.data = cloud_bytes(save)
	var refreshed: Dictionary = await save.initialize()
	check(refreshed.ok and save.snapshot().clouds.size() == 1, "only this game's namespace appears")
	check(not save.snapshot().local.has("bytes"), "UI snapshots never expose opaque save bytes")
	check(adapter.imports == 0 and provider.writes.is_empty(), "listing never overwrites local or uploads")
	var local: Dictionary = save.choose_local()
	check(local.ok and save.start_session(local.selection).ok, "local selection starts normally")
	save.notify_local_saved()
	await process_frame
	check(provider.writes.is_empty() and not save._auto_allowed, "ordinary local continue has no cloud write consent")
	check(save.choose_local().status == "requires_restart" and save.choose_new(true).status == "requires_restart" and (await save.choose_cloud("cloud-a")).status == "requires_restart", "low-level choices cannot replace a running game's save")
	save.stop()
	check(save.choose_new(true).status == "requires_restart", "stopping a service does not reopen destructive choices")
	save.dispose()
	save.free()
	save = service(provider, adapter)
	await save.refresh()
	check(save.choose_new().status == "confirmation_required" and adapter.creates == 0, "new save requires confirmation before local replacement")
	check(save.choose_cloud("not-listed").status == "not_listed", "arbitrary cloud UUID cannot be imported")
	var cloud: Dictionary = await save.choose_cloud("cloud-a", true)
	check(cloud.ok and adapter.imports == 1 and adapter.bytes.get_string_from_utf8() == "save:remote", "explicit verified cloud choice imports")
	check(provider.reports.size() == 1, "successful cloud import requests host storage sync")
	check(save.start_session(cloud.selection).ok and save._auto_allowed, "cloud choice checkbox enables session automation")
	var uploaded: Dictionary = await save.upload_local()
	check(uploaded.ok and provider.writes.back().uuid == "cloud-a", "selected cloud updates only its current uuid")
	check(save._target_file == "file-next", "successful update records changed file version")
	check((await save.upload_local()).status == "rate_limited" and provider.writes.size() == 1, "upload pacing prevents repeated sends")
	provider.rows[0]["file_id"] = "file-somebody-else"
	save._last_upload = -100.0
	var conflict: Dictionary = await save.upload_local()
	check(conflict.status == "conflict" and provider.writes.size() == 1, "remote version changes stop overwrite")
	save.dispose()
	save.free()

	# Awaiting callbacks cannot revive a cancelled session or undo an early local choice.
	provider.available = true
	provider.pending_frames = 0
	save = service(provider, adapter)
	provider.rows = [cloud_row(save)]
	provider.data = cloud_bytes(save)
	await save.refresh()
	provider.pending_frames = 2
	var imported_count := adapter.imports
	choose_later(save)
	save.stop()
	for i in 3:
		await process_frame
	check(async_result.status == "cancelled" and adapter.imports == imported_count, "stop during download never imports late bytes")
	refresh_later(save)
	check(save.choose_local().ok, "local fallback is usable while a cloud list is pending")
	for i in 3:
		await process_frame
	check(async_result.status == "cancelled" and save.snapshot().selection.source == "local", "late list cannot erase explicit local choice")
	provider.pending_frames = 0
	await save.refresh()
	local = save.choose_local(true)
	save.start_session(local.selection)
	var auto_count := provider.writes.size()
	save.notify_local_saved()
	save._next_upload = 0.0
	await process_frame
	check(provider.writes.size() == auto_count + 1 and provider.writes.back().uuid == "", "explicit local auto backup creates through debounce")
	save.dispose()
	save.free()

	# Namespace metadata is only a filter: payload and host schema must validate independently.
	save = service(provider, adapter)
	provider.rows = [cloud_row(save)]
	provider.data = cloud_bytes(save)
	await save.refresh()
	var before := adapter.bytes.duplicate()
	var bad: Dictionary = JSON.parse_string(provider.data.get_string_from_utf8())
	bad["game_id"] = "different.game"
	provider.data = JSON.stringify(bad).to_utf8_buffer()
	check((await save.choose_cloud("cloud-a")).status == "wrong_namespace" and adapter.bytes == before, "forged metadata cannot import another game envelope")
	bad["game_id"] = "test.game"
	bad["payload_sha256"] = "0000"
	provider.data = JSON.stringify(bad).to_utf8_buffer()
	check((await save.choose_cloud("cloud-a")).status == "integrity_failed" and adapter.bytes == before, "hash tampering preserves local bytes")
	provider.data = cloud_bytes(save, "invalid game content")
	check((await save.choose_cloud("cloud-a")).status == "invalid_save" and adapter.bytes == before, "valid envelope cannot bypass host validation")
	provider.data = cloud_bytes(save)
	adapter.fail_import = true
	check((await save.choose_cloud("cloud-a")).status == "local_write_failed" and adapter.bytes == before, "host write failure retains local authority")
	adapter.fail_import = false
	save.dispose()
	save.free()

	# New run / local consent creates a fresh archive; no remembered remote identity.
	save = service(provider, adapter)
	await save.refresh()
	local = save.choose_local(true)
	save.start_session(local.selection)
	provider.fail_write = true
	var failed: Dictionary = await save.upload_local()
	check(failed.status == "upload_failed" and provider.writes.back().uuid == "", "local backup consent creates without overwriting another slot")
	var count := provider.writes.size()
	save._last_upload = -100.0
	check((await save.upload_local()).status == "reconciliation_required" and provider.writes.size() == count, "unknown remote result blocks blind retry")
	provider.fail_write = false
	await save.refresh()
	check(save._target_uuid.is_empty() and not save._auto_allowed, "refresh invalidates prior cloud consent")
	save.dispose()
	save.free()

	# Stop/background cancellation prevents the continuation from overwriting local or cloud.
	save = service(provider, adapter)
	provider.rows = [cloud_row(save)]
	provider.data = cloud_bytes(save)
	await save.refresh()
	cloud = await save.choose_cloud("cloud-a", true)
	save.start_session(cloud.selection)
	provider.stop_on_list = save
	count = provider.writes.size()
	check((await save.upload_local()).status == "cancelled" and provider.writes.size() == count, "stop during preflight never proceeds to upload")
	save.dispose()
	save.free()
	save = service(provider, adapter)
	await save.refresh()
	cloud = await save.choose_cloud("cloud-a", true)
	save.start_session(cloud.selection)
	provider.lifecycle_changed.emit("background")
	check(not save._auto_allowed and save._target_uuid.is_empty(), "background revokes inaccessible account update consent")
	check(save.choose_new(true).status == "requires_restart", "background cannot unlock mid-game local replacement")
	save.dispose()
	save.free()
	save = service(provider, adapter)
	provider.available = false
	check((await save.refresh()).status == "local_only" and save.choose_local().ok, "unavailable provider preserves local play")
	save.dispose()
	save.free()

	# Grant tokens require provider verification, are unique per request and never award game state.
	var ads := AdsService.new()
	ads.setup(provider, {"enabled": true, "placements": {"revive": "rewarded", "between": "interstitial"}})
	root.add_child(ads)
	check((await ads.rewarded("unknown")).status == "unavailable", "unknown ad placement is not dispatched")
	var reward: Dictionary = await ads.rewarded("revive")
	check(reward.reward_eligible and reward.grant.verified and reward.grant.placement == "revive", "eligible close yields explicit consumable grant identifier")
	check(not (await ads.rewarded("revive")).reward_eligible, "duplicate SDK request cannot yield a second grant")
	provider.ad_result = {"status": "success", "request_id": "2", "reward_eligible": true, "simulated": true}
	check((await ads.rewarded("revive")).grant == null, "simulation can never mint a reward grant")
	provider.ad_result = {"status": "cancelled", "request_id": "3", "reward_eligible": false}
	check((await ads.rewarded("revive")).grant == null, "cancelled advertisement has no grant")
	provider.ad_result = {"status": "success", "request_id": "4", "reward_eligible": true}
	check((await ads.interstitial("between")).grant == null, "interstitial never grants even if a provider mislabels eligibility")
	check((await ads.interstitial("between")).status == "cooldown", "interstitial has session cooldown")
	ads.dispose()
	ads.free()

	# Deterministic clock exercises sustained writes without waiting a real minute.
	provider.available = true
	var clocked := ClockedSave.new()
	clocked.setup(provider, adapter, {"gameId": "test.game", "autoUpload": true, "debounceSeconds": 5.0})
	root.add_child(clocked)
	clocked.set_process(false)
	await clocked.refresh()
	local = clocked.choose_local(true)
	clocked.start_session(local.selection)
	var continuous_count := provider.writes.size()
	for second in range(1, 6):
		clocked.clock_now = 100.0 + second
		adapter.bytes = ("save:progress-" + str(second)).to_utf8_buffer()
		clocked.notify_local_saved()
		clocked._process(0)
	check(provider.writes.size() == continuous_count + 1, "continuous saves do not postpone the first debounce upload")
	var sent: Dictionary = JSON.parse_string(provider.writes.back().bytes.get_string_from_utf8())
	check(Marshalls.base64_to_raw(sent.payload_base64) == adapter.bytes, "debounced upload samples newest local bytes")
	provider.rows = [cloud_row(clocked, "new-id")]
	provider.rows[0]["file_id"] = "file-next"
	for second in range(6, 66):
		clocked.clock_now = 100.0 + second
		adapter.bytes = ("save:progress-" + str(second)).to_utf8_buffer()
		clocked.notify_local_saved()
		clocked._process(0)
	check(provider.writes.size() == continuous_count + 2, "continuous saves respect sixty-second pacing and still upload at deadline")
	clocked.dispose()
	clocked.free()

	var platform := PlatformService.new()
	platform.sdk_status = "unavailable"
	platform.platform = "web"
	root.add_child(platform)
	check((await platform.open_save_screen(adapter, {"gameId": "test.game", "enabled": true, "platforms": ["taptap-h5"]})).status == "skipped", "other platform targets skip startup UI entirely")
	platform.platform = "taptap-h5"
	platform.gameplay_start()
	check((await platform.open_save_screen(adapter, {"gameId": "test.game", "enabled": true})).status == "requires_restart", "running game cannot reopen importing picker")
	platform.gameplay_stop()
	check((await platform.open_save_screen(adapter, {"gameId": "test.game", "enabled": true})).status == "requires_restart", "paused gameplay still cannot reopen importing picker")
	platform.free()
	platform = PlatformService.new()
	platform.sdk_status = "unavailable"
	platform.platform = "taptap-h5"
	root.add_child(platform)
	complete_picker(platform)
	var opened: Dictionary = await platform.open_save_screen(adapter, {"gameId": "test.game", "enabled": true})
	check(opened.ok and opened.service == platform.active_save_service(), "factory picker returns live service for local fallback session")
	opened.service.dispose()
	await process_frame
	platform.free()
	provider.free()
	print("FWB_SERVICES_TEST checks=%d failures=%d" % [checks, failures])
	quit(0 if failures == 0 else 1)
