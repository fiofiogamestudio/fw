extends Node
## Optional platform boundary. The host owns gameplay, pausing, audio and rewards.

signal initialized(result: Dictionary)
signal lifecycle_changed(event: String)
signal ad_finished(result: Dictionary)
signal sdk_error(result: Dictionary)

const CONFIG_PATH := "res://fwb.runtime.json"

var platform := "web"
var sdk_status := "uninitialized"
var sdk_message := "等待初始化"
var simulated := false
var _bridge: JavaScriptObject
var _bridge_callback: JavaScriptObject
var _initializing := false
var _loading_complete := false
var _playing := false
var _foreground := true
var _request_counter := 0
var _active_request := ""
var _rewarded_available := false
var _commercial_available := false


func _ready() -> void:
	initialize.call_deferred()


func capabilities() -> Dictionary:
	return {
		"platform": platform,
		"sdk_status": sdk_status,
		"sdk_message": sdk_message,
		"lifecycle": true,
		"rewarded_ads": sdk_status == "ready" and _rewarded_available and not simulated,
		"commercial_ads": sdk_status == "ready" and _commercial_available and not simulated,
		"simulated": simulated,
	}


func initialize() -> Dictionary:
	if _initializing:
		return await initialized
	if sdk_status != "uninitialized":
		return capabilities()
	_initializing = true
	if FileAccess.file_exists(CONFIG_PATH):
		var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(CONFIG_PATH))
		if parsed is Dictionary:
			platform = str(parsed.get("platform", "web"))
			var sdk_config: Variant = parsed.get("sdk", {})
			if sdk_config is Dictionary:
				simulated = bool(sdk_config.get("mock", false))
	if simulated:
		_finish_init("unavailable", "模拟模式：不展示真实广告，不产生奖励资格")
	elif platform == "poki" and OS.has_feature("web"):
		_bridge = JavaScriptBridge.get_interface("FWBPoki")
		if _bridge != null:
			_bridge_callback = JavaScriptBridge.create_callback(_on_bridge_event)
			_bridge.initialize(_bridge_callback)
			return await initialized
		_finish_init("unavailable", "Poki 网页桥接脚本未装配")
	elif platform == "web":
		_finish_init("unavailable", "标准 Web 预览：未接入广告 SDK")
	else:
		_finish_init("unavailable", "当前环境未装配 %s SDK" % platform)
	return capabilities()


func loading_complete() -> void:
	if _loading_complete:
		return
	_loading_complete = true
	_send_event("gameLoadingFinished")


func gameplay_start() -> void:
	if _playing:
		return
	_playing = true
	_send_event("gameplayStart")


func gameplay_stop() -> void:
	if not _playing:
		return
	_playing = false
	_send_event("gameplayStop")


func request_rewarded_ad() -> Dictionary:
	return await _request_ad("rewarded")


func request_commercial_ad() -> Dictionary:
	return await _request_ad("commercial")


func _request_ad(kind: String) -> Dictionary:
	# All branches are asynchronous, including unavailable/busy responses.
	await get_tree().process_frame
	if _active_request != "":
		return _ad_result("error", kind, "busy", false)
	if sdk_status != "ready" or simulated or _bridge == null:
		return _ad_result("unavailable", kind, sdk_message, false)
	_request_counter += 1
	_active_request = str(_request_counter)
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
			_finish_init(str(payload.get("status", "error")), str(payload.get("message", "")))
		"ad":
			if str(payload.get("request_id", "")) != _active_request or _active_request == "":
				return
			_active_request = ""
			payload["platform"] = platform
			payload["simulated"] = simulated
			# Defense in depth: only a real rewarded success is eligible.
			payload["reward_eligible"] = payload.get("kind") == "rewarded" and payload.get("status") == "success" and payload.get("reward_eligible") == true and not simulated
			ad_finished.emit(payload)
		"ad_started":
			lifecycle_changed.emit("ad_started")
		"lifecycle":
			_set_foreground(payload.get("event") == "foreground")
		"error":
			sdk_error.emit(payload)


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT or what == NOTIFICATION_APPLICATION_PAUSED:
		_set_foreground(false)
	elif what == NOTIFICATION_APPLICATION_FOCUS_IN or what == NOTIFICATION_APPLICATION_RESUMED:
		_set_foreground(true)


func _set_foreground(value: bool) -> void:
	if value == _foreground:
		return
	_foreground = value
	lifecycle_changed.emit("foreground" if value else "background")
