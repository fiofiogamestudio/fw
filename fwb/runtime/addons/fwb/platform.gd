extends Node
## Environment and platform boundary. The host owns gameplay, audio and rewards.

signal initialized(result: Dictionary)
signal lifecycle_changed(event: String)
signal interruption_changed(paused: bool, reasons: Array)
signal storage_changed(result: Dictionary)
signal ad_finished(result: Dictionary)
signal request_finished(result: Dictionary)
signal sdk_error(result: Dictionary)

const CONFIG_PATH := "res://fwb.runtime.json"
const ENVIRONMENT_REASONS := ["focus", "os_paused", "page_hidden", "page_frozen", "platform_hidden"]
const SaveServiceScript = preload("services/save_service.gd")
const AdsServiceScript = preload("services/ads_service.gd")

var platform := "web"
var sdk_status := "uninitialized"
var sdk_message := "等待初始化"
var simulated := false
var _bridge: JavaScriptObject
var _bridge_callback: JavaScriptObject
var _web_bridge: JavaScriptObject
var _web_callback: JavaScriptObject
var _initializing := false
var _loading_complete := false
var _playing := false
var _gameplay_has_started := false
var _foreground := true
var _request_counter := 0
var _active_request := ""
var _rewarded_available := false
var _commercial_available := false
var _cloud_available := false
var _pause_reasons: Dictionary = {}
var _requests: Dictionary = {}
var _config: Dictionary = {}
var _configuration_loaded := false
var _storage: Dictionary = {"state": "unknown", "durability": "unknown", "file_written": false}
var _save_screen_active := false
var _active_save_service: WeakRef


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	initialize.call_deferred()


func capabilities() -> Dictionary:
	return {
		"platform": platform, "sdk_status": sdk_status, "sdk_message": sdk_message,
		"lifecycle": true, "interruptions": true, "local_storage_status": true,
		"rewarded_ads": sdk_status == "ready" and _rewarded_available and not simulated,
		"commercial_ads": sdk_status == "ready" and _commercial_available and not simulated,
		"cloud_save": sdk_status == "ready" and _cloud_available and not simulated,
		# No documented H5 player-login contract has been verified. Never borrow APK APIs.
		"login": false, "simulated": simulated,
	}


func initialize() -> Dictionary:
	if _initializing:
		return await initialized
	if sdk_status != "uninitialized":
		return capabilities()
	_initializing = true
	_read_configuration()
	platform = str(_config.get("platform", "web"))
	var sdk_config: Variant = _config.get("sdk", {})
	if sdk_config is Dictionary:
		simulated = bool(sdk_config.get("mock", false))
	if OS.has_feature("web"):
		_web_bridge = JavaScriptBridge.get_interface("FWBWeb")
		if _web_bridge != null:
			_web_callback = JavaScriptBridge.create_callback(_on_bridge_event)
			_web_bridge.initialize(_web_callback)
	if simulated:
		_finish_init("unavailable", "模拟模式：不展示真实广告，不产生奖励资格")
	elif OS.has_feature("web") and platform in ["poki", "taptap-h5"]:
		_bridge = JavaScriptBridge.get_interface("FWBPoki" if platform == "poki" else "FWBTapTap")
		if _bridge != null:
			_bridge_callback = JavaScriptBridge.create_callback(_on_bridge_event)
			_bridge.initialize(_bridge_callback, JSON.stringify(_config))
			return await initialized
		_finish_init("unavailable", "%s 网页桥接脚本未装配" % platform)
	else:
		_finish_init("unavailable", "当前环境未装配 %s SDK" % platform)
	return capabilities()


func loading_complete() -> void:
	if _loading_complete:
		return
	_loading_complete = true
	_send_event("gameLoadingFinished")


func get_save_flow_options(options: Dictionary = {}) -> Dictionary:
	_read_configuration()
	var result: Dictionary = _config.get("saveFlow", {}).duplicate(true)
	result.merge(options, true)
	return result


func create_save_service(adapter: Object, options: Dictionary = {}) -> Node:
	var service := SaveServiceScript.new()
	service.setup(self, adapter, get_save_flow_options(options))
	add_child(service)
	return service


func active_save_service() -> Node:
	return _active_save_service.get_ref() if _active_save_service != null else null


func create_ads_service(options: Dictionary = {}) -> Node:
	_read_configuration()
	var settings: Dictionary = _config.get("ads", {}).duplicate(true)
	settings.merge(options, true)
	var service := AdsServiceScript.new()
	service.setup(self, settings)
	add_child(service)
	return service


func _read_configuration() -> void:
	if _configuration_loaded:
		return
	_configuration_loaded = true
	if FileAccess.file_exists(CONFIG_PATH):
		var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(CONFIG_PATH))
		if parsed is Dictionary:
			_config = parsed


## Await before creating gameplay. Other targets return skipped with no UI or provider request.
func open_save_screen(adapter: Object, options: Dictionary = {}) -> Dictionary:
	await initialize()
	var settings := get_save_flow_options(options)
	var platforms: Array = settings.get("platforms", ["taptap-h5"])
	if not settings.get("enabled", false) or not platform in platforms:
		return {"ok": true, "status": "skipped"}
	if _gameplay_has_started:
		return {"ok": false, "status": "requires_restart", "message": "请重新打开游戏选择存档，不能替换正在运行的游戏进度。"}
	if _save_screen_active:
		return {"ok": false, "status": "busy", "message": "存档界面已打开。"}
	_save_screen_active = true
	var service := create_save_service(adapter, settings)
	var screen_script: Script = load("res://addons/fwb/ui/save_start_screen.gd")
	if screen_script == null:
		_save_screen_active = false
		service.dispose()
		service.queue_free()
		return {"ok": false, "status": "screen_unavailable"}
	var screen: Node = screen_script.new()
	screen.configure(service, settings)
	# Autoloads enter the tree before the host's main scene. A separate canvas keeps
	# the picker above backgrounds regardless of that scene's draw order.
	var layer := CanvasLayer.new()
	layer.name = "FwbSaveStartLayer"
	layer.layer = 100
	add_child(layer)
	layer.add_child(screen)
	var result: Dictionary = await screen.completed
	_save_screen_active = false
	layer.queue_free()
	if result.get("ok", false) and result.has("selection"):
		service.start_session(result.selection)
		var previous := active_save_service()
		if previous != null and previous != service:
			previous.dispose()
			previous.queue_free()
		_active_save_service = weakref(service)
		result["service"] = service
	else:
		service.dispose()
		service.queue_free()
	return result


func gameplay_start() -> void:
	_gameplay_has_started = true
	if _playing:
		return
	_playing = true
	_send_event("gameplayStart")


func gameplay_stop() -> void:
	if not _playing:
		return
	_playing = false
	_send_event("gameplayStop")


func set_pause_reason(reason: String, active: bool) -> void:
	if reason.is_empty() or _pause_reasons.has(reason) == active:
		return
	if active:
		_pause_reasons[reason] = true
	else:
		_pause_reasons.erase(reason)
	var reasons: Array = _pause_reasons.keys()
	reasons.sort()
	interruption_changed.emit(not reasons.is_empty(), reasons)


func interruption_state() -> Dictionary:
	var reasons: Array = _pause_reasons.keys()
	reasons.sort()
	return {"paused": not reasons.is_empty(), "reasons": reasons, "foreground": _foreground}


func storage_status() -> Dictionary:
	var result := _storage.duplicate(true)
	result["backend"] = "godot_userfs" if OS.has_feature("web") else "native_file"
	# This flag is advisory only: it is not a write acknowledgement or durable transaction.
	result["persistent_hint"] = OS.is_userfs_persistent()
	return result


func report_file_written(path: String) -> Dictionary:
	# Called only AFTER the host's own write/rename succeeds. No save schema or second copy.
	_storage = {"state": "file_written", "durability": "unknown", "file_written": true, "path": path}
	storage_changed.emit(storage_status())
	return request_storage_sync()


func request_storage_sync() -> Dictionary:
	if OS.has_feature("web"):
		JavaScriptBridge.force_fs_sync()
		_storage["state"] = "sync_requested"
		# Godot exposes no completion callback for force_fs_sync(). Do not claim confirmed.
		_storage["durability"] = "unknown"
	storage_changed.emit(storage_status())
	return storage_status()


func request_rewarded_ad() -> Dictionary:
	return await _request_ad("rewarded")


func request_commercial_ad() -> Dictionary:
	return await _request_ad("commercial")


func list_cloud_archives() -> Dictionary:
	return await _request_service("cloud_list", {})


func write_cloud_bytes(data: PackedByteArray, metadata: Dictionary, archive_uuid: String = "") -> Dictionary:
	return await _request_service("cloud_write", {"data_base64": Marshalls.raw_to_base64(data),
		"metadata": metadata, "archive_uuid": archive_uuid})


func read_cloud_bytes(archive_uuid: String, file_id: String) -> Dictionary:
	var result: Dictionary = await _request_service("cloud_read", {"archive_uuid": archive_uuid, "file_id": file_id})
	if result.get("status") == "success":
		result["data"] = Marshalls.base64_to_raw(str(result.get("data_base64", "")))
		result.erase("data_base64")
	return result


func _request_service(operation: String, payload: Dictionary) -> Dictionary:
	await get_tree().process_frame
	if not capabilities()["cloud_save"] or _bridge == null:
		return {"status": "unavailable", "operation": operation, "platform": platform}
	_request_counter += 1
	var request_id := str(_request_counter)
	_requests[request_id] = true
	_bridge.request(operation, JSON.stringify(payload), request_id)
	while _requests.has(request_id):
		var result: Dictionary = await request_finished
		if str(result.get("request_id", "")) == request_id:
			return result
	return {"status": "error", "message": "request lost", "request_id": request_id}


func _request_ad(kind: String) -> Dictionary:
	await get_tree().process_frame
	if _active_request != "" or _pause_reasons.has("ad"):
		return _ad_result("error", kind, "busy", false)
	if sdk_status != "ready" or simulated or _bridge == null:
		return _ad_result("unavailable", kind, sdk_message, false)
	_request_counter += 1
	_active_request = str(_request_counter)
	set_pause_reason("ad", true)
	_bridge.requestAd(kind, _active_request)
	return await ad_finished


func _ad_result(status: String, kind: String, message: String, reward_eligible: bool) -> Dictionary:
	return {"status": status, "kind": kind, "message": message,
		"reward_eligible": reward_eligible, "simulated": simulated, "platform": platform}


func _finish_init(status: String, message: String) -> void:
	sdk_status = status
	sdk_message = message
	_initializing = false
	if status == "ready":
		if _loading_complete:
			_send_event("gameLoadingFinished")
		if _playing:
			_send_event("gameplayStart")
	initialized.emit(capabilities())


func _send_event(event: String) -> void:
	if sdk_status == "ready" and _bridge != null:
		_bridge.event(event)


func _on_bridge_event(args: Array) -> void:
	if args.is_empty():
		return
	var payload: Variant = JSON.parse_string(str(args[0]))
	if not payload is Dictionary:
		return
	match str(payload.get("type", "")):
		"init":
			_rewarded_available = bool(payload.get("rewarded_ads", false))
			_commercial_available = bool(payload.get("commercial_ads", false))
			_cloud_available = bool(payload.get("cloud_save", false))
			_finish_init(str(payload.get("status", "error")), str(payload.get("message", "")))
		"ad":
			if str(payload.get("request_id", "")) != _active_request or _active_request == "":
				return
			_active_request = ""
			payload["platform"] = platform
			payload["simulated"] = simulated
			payload["reward_eligible"] = payload.get("kind") == "rewarded" and payload.get("status") == "success" and payload.get("reward_eligible") == true and not simulated
			if not payload.get("pending", false):
				set_pause_reason("ad", false)
			ad_finished.emit(payload)
		"ad_started":
			lifecycle_changed.emit("ad_started")
		"ad_settled":
			set_pause_reason("ad", false)
		"request":
			var request_id := str(payload.get("request_id", ""))
			if not _requests.has(request_id):
				return
			_requests.erase(request_id)
			payload["platform"] = platform
			request_finished.emit(payload)
		"environment":
			_set_environment_reason(str(payload.get("reason", "")), bool(payload.get("active", false)))
		"lifecycle":
			_set_environment_reason("platform_hidden", payload.get("event") == "background")
		"error":
			sdk_error.emit(payload)


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_APPLICATION_FOCUS_OUT:
			_set_environment_reason("focus", true)
		NOTIFICATION_APPLICATION_FOCUS_IN:
			_set_environment_reason("focus", false)
		NOTIFICATION_APPLICATION_PAUSED:
			_set_environment_reason("os_paused", true)
		NOTIFICATION_APPLICATION_RESUMED:
			_set_environment_reason("os_paused", false)


func _set_environment_reason(reason: String, active: bool) -> void:
	if reason not in ENVIRONMENT_REASONS:
		return
	set_pause_reason(reason, active)
	var foreground := true
	for item in ENVIRONMENT_REASONS:
		if _pause_reasons.has(item):
			foreground = false
	if foreground == _foreground:
		return
	_foreground = foreground
	lifecycle_changed.emit("foreground" if foreground else "background")
