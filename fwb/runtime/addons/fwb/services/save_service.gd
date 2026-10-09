extends Node
## Run-session scoped orchestration over an opaque host save adapter.
## No game schema, authoritative local file, or persistent cloud binding lives here.

signal state_changed(state: Dictionary)

const FORMAT := "fwb.save"
const VERSION := 1
const MAX_PAYLOAD_BYTES := 7 * 1024 * 1024
const MAX_ENVELOPE_BYTES := 10 * 1024 * 1024
const MIN_UPLOAD_SECONDS := 60.0

var _platform: Object
var _adapter: Object
var _options: Dictionary = {}
var _state: Dictionary = {}
var _archives: Dictionary = {}
var _epoch := 0
var _disposed := false
var _session := false
var _session_started := false
var _dirty := false
var _next_upload := 0.0
var _last_upload := -MIN_UPLOAD_SECONDS
var _auto_allowed := false
var _create_allowed := false
var _target_uuid := ""
var _target_file := ""
var _remote_uncertain := false
var _selection: Dictionary = {}
var _selection_nonce := ""
var _operation := ""


func setup(platform: Object, adapter: Object, options: Dictionary = {}) -> void:
	_platform = platform
	_adapter = adapter
	_options = options.duplicate(true)
	process_mode = Node.PROCESS_MODE_ALWAYS
	if is_instance_valid(_platform) and _platform.has_signal("lifecycle_changed"):
		_platform.lifecycle_changed.connect(_on_lifecycle)
	_state = {"phase": "idle", "status": "idle", "local": {}, "clouds": [], "archives": [],
		"loading": false, "busy": false, "cloud_available": false, "error": "", "message": "", "selection": {}}
	_update_local()
	var game_id := str(_options.get("gameId", ""))
	if not _identifier(game_id) or not _identifier(str(_options.get("slot", "main"))):
		_state["error"] = "gameId 和 slot 必须是稳定且唯一的英文、数字、点、下划线或短横线标识。"
		_state["phase"] = "invalid_config"
	if not _adapter_ready():
		_state["error"] = "存档适配器不完整。"
		_state["phase"] = "invalid_config"
	_publish()


func snapshot() -> Dictionary:
	var state := _state.duplicate(true)
	state["auto_backup_active"] = _session and _auto_allowed
	state["auto_backup_supported"] = bool(_options.get("autoUpload", false))
	state["backup_suspended"] = bool(_state.get("backup_suspended", false))
	state["remote_uncertain"] = _remote_uncertain
	state["upload_target"] = "new" if _target_uuid.is_empty() else "selected"
	return state


func initialize() -> Dictionary:
	return await refresh()


func refresh() -> Dictionary:
	if _disposed or _state.get("phase") == "invalid_config":
		return _failure("invalid_config", str(_state.get("error", "Service unavailable")))
	if not _operation.is_empty():
		return _failure("busy", "存档操作正在进行。")
	# A fresh list invalidates previous session consent: the container may now have another account.
	_reset_consent()
	_archives.clear()
	_state["clouds"] = []
	_state["archives"] = []
	_update_local()
	_begin("refresh")
	var epoch := _epoch
	if is_instance_valid(_platform) and _platform.has_method("initialize"):
		await _platform.initialize()
	if not _current(epoch):
		return _failure("cancelled", "")
	var available := is_instance_valid(_platform) and _platform.has_method("capabilities") and bool(_platform.capabilities().get("cloud_save", false))
	_state["cloud_available"] = available
	if not available:
		return _finish({"ok": true, "status": "local_only", "message": "云存档当前不可用，可以继续本地游戏。"})
	var result: Dictionary = await _platform.list_cloud_archives()
	if not _current(epoch):
		return _failure("cancelled", "")
	if result.get("status") != "success":
		return _finish(_failure("cloud_error", str(result.get("message", "读取云存档失败，可以继续本地游戏。"))))
	_apply_archives(result.get("archives", []))
	return _finish({"ok": true, "status": "ready"})


func choose_local(auto_backup: bool = false) -> Dictionary:
	if _session_started:
		return _failure("requires_restart", "游戏已开始，请重新打开游戏选择存档。")
	if not _can_choose():
		return _failure("busy", "存档操作正在进行。")
	_update_local()
	var local: Dictionary = _state.get("local", {})
	if not local.get("available", false):
		return _failure("no_local_save", "没有可用的本地存档。")
	_cancel_refresh()
	_reset_consent()
	_create_allowed = auto_backup
	return _select("local", "", auto_backup)


func choose_new(confirmed: bool = false, auto_backup: bool = false) -> Dictionary:
	if _session_started:
		return _failure("requires_restart", "游戏已开始，请重新打开游戏选择存档。")
	if not _can_choose():
		return _failure("busy", "存档操作正在进行。")
	_update_local()
	if _state.get("local", {}).get("exists", false) and not confirmed:
		return _failure("confirmation_required", "重新开始将替换本地进度，请先确认。")
	_cancel_refresh()
	var result: Dictionary = _adapter.create_new_save()
	if not result.get("ok", false):
		return _finish(_failure("local_write_failed", str(result.get("message", "创建本地存档失败。"))))
	_report_written(result)
	_reset_consent()
	_create_allowed = auto_backup
	_update_local()
	return _select("new", "", auto_backup)


func choose_cloud(id: String, auto_backup: bool = false) -> Dictionary:
	if _session_started:
		return _failure("requires_restart", "游戏已开始，请重新打开游戏选择存档。")
	if not _can_choose() or _operation == "refresh":
		return _failure("busy", "请等候云存档列表加载完成。")
	if not _archives.has(id):
		return _failure("not_listed", "请刷新并选择本次列出的云存档。")
	var archive: Dictionary = _archives[id].duplicate(true)
	_begin("download")
	var epoch := _epoch
	var response: Dictionary = await _platform.read_cloud_bytes(str(archive.archive_uuid), str(archive.file_id))
	if not _current(epoch):
		return _failure("cancelled", "")
	if response.get("status") != "success":
		return _finish(_failure("download_failed", str(response.get("message", "下载失败，本地存档已保留。"))))
	var decoded := _decode_envelope(response.get("data", PackedByteArray()))
	if not decoded.get("ok", false):
		return _finish(decoded)
	var bytes: PackedByteArray = decoded.data
	var valid: Dictionary = _adapter.validate_save(bytes)
	if not valid.get("ok", false):
		return _finish(_failure("invalid_save", str(valid.get("message", "此存档与当前游戏不兼容，本地存档已保留。"))))
	# Only this explicit user action is permitted to replace the host's local master.
	var imported: Dictionary = _adapter.import_save(bytes)
	if not imported.get("ok", false):
		return _finish(_failure("local_write_failed", str(imported.get("message", "写入失败，未切换存档。"))))
	_report_written(imported)
	_reset_consent()
	_remote_uncertain = false
	_target_uuid = str(archive.archive_uuid)
	_target_file = str(archive.file_id)
	_update_local()
	return _select("cloud", id, auto_backup)


func start_session(selection: Dictionary) -> Dictionary:
	if _disposed or _selection_nonce.is_empty() or selection.get("token", "") != _selection_nonce:
		return _failure("invalid_selection", "请选择本次启动的存档。")
	_session = true
	_session_started = true
	_auto_allowed = bool(_selection.get("auto_backup", false)) and bool(_options.get("autoUpload", false))
	_state["backup_suspended"] = false
	if _auto_allowed and _create_allowed:
		notify_local_saved()
	_state["phase"] = "playing"
	_publish()
	return {"ok": true, "status": "started"}


func notify_local_saved() -> void:
	if _disposed:
		return
	_update_local()
	if _session and _auto_allowed and not _remote_uncertain:
		if not _dirty:
			# Continuous gameplay saves must not postpone the first pending backup forever.
			_next_upload = maxf(_now() + float(_options.get("debounceSeconds", 5.0)), _last_upload + MIN_UPLOAD_SECONDS)
		_dirty = true
	_publish()


## A manual call is explicit consent to create a new cloud slot when none was selected.
## Existing cloud slots are updated only after this session selected their verified bytes.
func upload_local() -> Dictionary:
	return await _upload(false)


func stop() -> void:
	_session = false
	_dirty = false
	_auto_allowed = false
	if _operation == "upload":
		_remote_uncertain = true
	_epoch += 1
	_operation = ""
	_state["busy"] = false
	_state["loading"] = false


func dispose() -> void:
	stop()
	_disposed = true
	_epoch += 1
	_reset_consent()
	set_process(false)
	if is_instance_valid(_platform) and _platform.has_signal("lifecycle_changed") and _platform.lifecycle_changed.is_connected(_on_lifecycle):
		_platform.lifecycle_changed.disconnect(_on_lifecycle)


func _on_lifecycle(event: String) -> void:
	if event == "background":
		# H5 exposes no verified account identity. Never carry update consent through a resume.
		stop()
		_reset_consent()
		_archives.clear()
		_state["clouds"] = []
		_state["archives"] = []
		_state["status"] = "backup_suspended"
		_state["backup_suspended"] = true
		_state["message"] = "返回后台后已暂停自动备份；请重新打开游戏并选择存档以恢复。"
		_publish()


func _report_written(result: Dictionary) -> void:
	if result.has("path") and is_instance_valid(_platform) and _platform.has_method("report_file_written"):
		_platform.report_file_written(str(result.path))


func _process(_delta: float) -> void:
	if _session and _auto_allowed and _dirty and not _remote_uncertain and _operation.is_empty() and _now() >= _next_upload:
		_dirty = false
		_upload(true)


func _upload(automatic: bool) -> Dictionary:
	if _disposed or not _adapter_ready() or _state.get("phase") == "invalid_config":
		return _failure("unavailable", "")
	if not _operation.is_empty():
		return _failure("busy", "存档操作正在进行。")
	if _remote_uncertain:
		return _failure("reconciliation_required", "上次上传结果未确认，请重新列出并选择云存档后再同步。")
	if automatic and (not _auto_allowed or (_target_uuid.is_empty() and not _create_allowed)):
		return _failure("consent_required", "需要本局明确同意云备份。")
	if not is_instance_valid(_platform) or not _platform.capabilities().get("cloud_save", false):
		return _failure("unavailable", "云存档当前不可用。")
	var remaining := (_last_upload + MIN_UPLOAD_SECONDS) - _now()
	if remaining > 0:
		if automatic:
			_dirty = true
			_next_upload = _now() + remaining
		return {"ok": false, "status": "rate_limited", "retry_after_ms": ceili(remaining * 1000.0)}
	var local: Dictionary = _adapter.get_local_snapshot()
	var bytes: Variant = local.get("bytes", PackedByteArray())
	if not local.get("exists", false) or not local.get("valid", false) or not bytes is PackedByteArray:
		return _failure("invalid_local_save", "本地存档不可上传。")
	var validated: Dictionary = _adapter.validate_save(bytes)
	if not validated.get("ok", false):
		return _failure("invalid_local_save", str(validated.get("message", "本地存档不可上传。")))
	var encoded := _encode_envelope(bytes, local)
	if not encoded.get("ok", false):
		return encoded
	# This request has sampled the newest local bytes. A new save during either await
	# below marks a distinct pending backup; completion does not clear that next dirty bit.
	_dirty = false
	_begin("upload")
	var epoch := _epoch
	if not _target_uuid.is_empty():
		# The SDK has no CAS. Catch observed remote changes instead of silently overwriting them.
		var listed: Dictionary = await _platform.list_cloud_archives()
		if not _current(epoch):
			return _failure("cancelled", "")
		if listed.get("status") != "success":
			return _finish(_failure("cloud_error", "无法确认云档版本，本地存档已保留。"))
		var found: Dictionary = _find_archive(listed.get("archives", []), _target_uuid)
		if found.is_empty() or str(found.get("file_id", "")) != _target_file:
			_auto_allowed = false
			return _finish(_failure("conflict", "云存档已变化，请刷新后重新选择。本地存档已保留。"))
	_last_upload = _now()
	var response: Dictionary = await _platform.write_cloud_bytes(encoded.data, encoded.metadata, _target_uuid)
	if not _current(epoch):
		return _failure("cancelled", "")
	if response.get("status") != "success":
		if response.get("remote_outcome") == "unknown":
			_remote_uncertain = true
			_auto_allowed = false
		if response.get("code") == "rate_limited" and automatic:
			_dirty = true
			_next_upload = _now() + maxf(MIN_UPLOAD_SECONDS, float(response.get("retry_after_ms", 60000)) / 1000.0)
		var failure := _failure("upload_failed", str(response.get("message", "云备份失败，本地存档已保留。")))
		failure["remote_outcome"] = response.get("remote_outcome", "not_started")
		return _finish(failure)
	var archive: Variant = response.get("archive", response)
	var uuid := str(archive.get("archive_uuid", archive.get("uuid", ""))) if archive is Dictionary else ""
	var file_id := str(archive.get("file_id", archive.get("fileId", ""))) if archive is Dictionary else ""
	if not _identifier(uuid, 160) or not _identifier(file_id, 160) or (not _target_uuid.is_empty() and uuid != _target_uuid):
		# A confirmed upload without a usable receipt is not permission to update an arbitrary slot.
		_auto_allowed = false
		_target_uuid = ""
		_target_file = ""
		return _finish({"ok": true, "status": "uploaded_reselect", "message": "云备份已提交，请刷新列表后选择该云档以继续自动同步。"})
	_target_uuid = uuid
	_target_file = file_id
	_create_allowed = false
	return _finish({"ok": true, "status": "uploaded", "archive_uuid": uuid, "file_id": file_id})


func _encode_envelope(bytes: PackedByteArray, local: Dictionary) -> Dictionary:
	if bytes.is_empty() or bytes.size() > MAX_PAYLOAD_BYTES:
		return _failure("save_too_large", "存档为空或超过 7 MiB 的备份上限。")
	var summary := str(local.get("summary", "")).left(120)
	var envelope := {"format": FORMAT, "version": VERSION, "game_id": str(_options.gameId),
		"slot": str(_options.get("slot", "main")), "payload_base64": Marshalls.raw_to_base64(bytes),
		"payload_sha256": _sha256(bytes), "payload_size": bytes.size(),
		"summary": summary, "updated_at": float(local.get("updated_at", 0)), "playtime": maxf(0, float(local.get("playtime", 0)))}
	var data := JSON.stringify(envelope).to_utf8_buffer()
	if data.size() > MAX_ENVELOPE_BYTES:
		return _failure("save_too_large", "云存档封装超过 10 MiB。")
	return {"ok": true, "data": data, "metadata": {"name": _archive_name(), "summary": summary,
		"playtime": envelope.playtime, "extra": JSON.stringify({"fwb": VERSION, "game_id": envelope.game_id, "slot": envelope.slot})}}


func _decode_envelope(raw: Variant) -> Dictionary:
	if not raw is PackedByteArray or raw.is_empty() or raw.size() > MAX_ENVELOPE_BYTES:
		return _failure("invalid_envelope", "云存档数据不完整，本地存档已保留。")
	var envelope: Variant = JSON.parse_string(raw.get_string_from_utf8())
	if not envelope is Dictionary or envelope.get("format") != FORMAT or envelope.get("version") != VERSION or envelope.get("game_id") != _options.gameId or envelope.get("slot") != _options.get("slot", "main"):
		return _failure("wrong_namespace", "云存档不属于当前游戏或存档槽。")
	var encoded: Variant = envelope.get("payload_base64")
	var hash: Variant = envelope.get("payload_sha256")
	var size: Variant = envelope.get("payload_size")
	if not encoded is String or not hash is String or not (size is float or size is int) or size <= 0 or size > MAX_PAYLOAD_BYTES:
		return _failure("invalid_envelope", "云存档格式不完整。")
	var bytes := Marshalls.base64_to_raw(encoded)
	if bytes.size() != size or _sha256(bytes) != hash or Marshalls.raw_to_base64(bytes) != encoded:
		return _failure("integrity_failed", "云存档校验失败，本地存档已保留。")
	return {"ok": true, "data": bytes}


func _apply_archives(raw: Variant) -> void:
	_archives.clear()
	var visible: Array = []
	if raw is Array:
		for value in raw:
			if not _matches_archive(value):
				continue
			var entry: Dictionary = value.duplicate(true)
			var id := str(entry.archive_uuid)
			if _archives.has(id):
				continue
			entry["id"] = id
			entry["label"] = str(entry.get("summary", "云存档")).left(160)
			entry["verified"] = false
			_archives[id] = entry
			visible.append(entry)
	_state["clouds"] = visible
	_state["archives"] = visible


func _find_archive(raw: Variant, uuid: String) -> Dictionary:
	if raw is Array:
		for value in raw:
			if _matches_archive(value) and value.get("archive_uuid") == uuid:
				return value
	return {}


func _matches_archive(value: Variant) -> bool:
	if not value is Dictionary or not _identifier(str(value.get("archive_uuid", "")), 160) or not _identifier(str(value.get("file_id", "")), 160) or value.get("name") != _archive_name():
		return false
	var extra: Variant = JSON.parse_string(str(value.get("extra", "")))
	return extra is Dictionary and extra.get("fwb") == VERSION and extra.get("game_id") == _options.gameId and extra.get("slot") == _options.get("slot", "main")


func _archive_name() -> String:
	return "fwb-" + (str(_options.get("gameId", "")) + "\n" + str(_options.get("slot", "main"))).sha256_text().left(48)


func _update_local() -> void:
	var local: Dictionary = {}
	if is_instance_valid(_adapter) and _adapter.has_method("get_local_snapshot"):
		local = _adapter.get_local_snapshot().duplicate(true)
	local.erase("bytes")
	local["available"] = bool(local.get("exists", false)) and bool(local.get("valid", false))
	local["label"] = str(local.get("summary", "本地存档"))
	_state["local"] = local


func _adapter_ready() -> bool:
	return is_instance_valid(_adapter) and _adapter.has_method("get_local_snapshot") and _adapter.has_method("validate_save") and _adapter.has_method("import_save") and _adapter.has_method("create_new_save")


func _select(source: String, id: String, auto_backup: bool) -> Dictionary:
	_selection_nonce = Crypto.new().generate_random_bytes(16).hex_encode()
	_selection = {"source": source, "id": id, "auto_backup": auto_backup, "token": _selection_nonce}
	_state["selection"] = _selection.duplicate(true)
	return _finish({"ok": true, "status": "selected", "selection": _selection.duplicate(true)})


func _reset_consent() -> void:
	_session = false
	_dirty = false
	_auto_allowed = false
	_create_allowed = false
	_target_uuid = ""
	_target_file = ""
	_selection_nonce = ""
	_selection.clear()
	_state["selection"] = {}


func _can_choose() -> bool:
	return not _disposed and _state.get("phase") != "invalid_config" and (_operation.is_empty() or _operation == "refresh")


func _cancel_refresh() -> void:
	if _operation == "refresh":
		_epoch += 1
		_operation = ""
		_state["busy"] = false
		_state["loading"] = false


func _begin(operation: String) -> void:
	_epoch += 1
	_operation = operation
	_state["phase"] = operation
	_state["busy"] = true
	_state["loading"] = operation == "refresh"
	_state["error"] = ""
	_publish()


func _finish(result: Dictionary) -> Dictionary:
	_operation = ""
	_state["busy"] = false
	_state["loading"] = false
	_state["status"] = result.get("status", "error")
	_state["phase"] = "playing" if _session else "ready"
	_state["error"] = "" if result.get("ok", false) else str(result.get("message", ""))
	_state["message"] = str(result.get("message", ""))
	_state["remote_uncertain"] = _remote_uncertain
	_publish()
	return result


func _publish() -> void:
	if not _disposed:
		state_changed.emit(snapshot())


func _current(epoch: int) -> bool:
	return not _disposed and epoch == _epoch


func _identifier(value: String, limit: int = 100) -> bool:
	if value.is_empty() or value.length() > limit:
		return false
	for character in value:
		if not (character >= "a" and character <= "z") and not (character >= "A" and character <= "Z") and not (character >= "0" and character <= "9") and not character in ["_", "-", "."]:
			return false
	return true


func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


func _sha256(bytes: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(bytes)
	return context.finish().hex_encode()


func _failure(status: String, message: String) -> Dictionary:
	return {"ok": false, "status": status, "message": message}
