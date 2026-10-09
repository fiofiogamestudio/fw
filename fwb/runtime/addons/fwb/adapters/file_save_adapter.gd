extends RefCounted
## Optional adapter for one local master file. Schemas stay in host callbacks.
## Replace only before gameplay begins, never behind a running game's model.

var save_path: String = ""
var max_bytes: int = 524288
var _validator: Callable
var _factory: Callable

func setup(path: String, validator: Callable, factory: Callable, limit: int = 524288) -> void:
	save_path = path
	_validator = validator
	_factory = factory
	max_bytes = clampi(limit, 1, 9 * 1024 * 1024)

func get_local_snapshot() -> Dictionary:
	if not FileAccess.file_exists(save_path):
		return {"exists": false, "valid": false, "summary": "尚无本地存档"}
	var file := FileAccess.open(save_path, FileAccess.READ)
	if file == null:
		return {"exists": true, "valid": false, "summary": "本地存档无法读取"}
	if file.get_length() > max_bytes:
		file.close()
		return {"exists": true, "valid": false, "summary": "本地存档超过大小限制"}
	var data: PackedByteArray = file.get_buffer(file.get_length())
	file.close()
	var checked: Dictionary = validate_save(data)
	return {"exists": true, "valid": bool(checked.get("ok", false)), "bytes": data,
		"summary": str(checked.get("summary", checked.get("message", "存档无效"))).left(512),
		"updated_at": FileAccess.get_modified_time(save_path), "playtime": checked.get("playtime", 0)}

func validate_save(data: PackedByteArray) -> Dictionary:
	if data.is_empty() or data.size() > max_bytes or not _validator.is_valid():
		return {"ok": false, "message": "存档为空、超过大小限制或未配置校验方法。"}
	var result: Variant = _validator.call(data)
	if not result is Dictionary or result.get("ok") != true:
		return result if result is Dictionary else {"ok": false, "message": "存档校验失败。"}
	return result

func import_save(data: PackedByteArray) -> Dictionary:
	var checked: Dictionary = validate_save(data)
	if not checked.get("ok", false):
		return checked
	if not save_path.begins_with("user://") or save_path.contains(".."):
		return {"ok": false, "message": "本地存档路径必须位于 user://。"}
	# Previous bytes are recoverable, but never read as an alternate master.
	if FileAccess.file_exists(save_path):
		var error: Error = DirAccess.copy_absolute(save_path, save_path + ".before-replace.tmp")
		if error == OK:
			error = DirAccess.rename_absolute(save_path + ".before-replace.tmp", save_path + ".before-replace")
		if error != OK:
			return {"ok": false, "message": "原存档备份失败，未替换进度。"}
	var temporary: String = save_path + ".fwb-import.tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		return {"ok": false, "message": "存档写入失败，原进度已保留。"}
	file.store_buffer(data)
	file.flush()
	var write_error: Error = file.get_error()
	file.close()
	if write_error != OK or DirAccess.rename_absolute(temporary, save_path) != OK:
		return {"ok": false, "message": "存档替换失败，原进度已保留。"}
	return {"ok": true, "path": save_path}

func create_new_save() -> Dictionary:
	if not _factory.is_valid():
		return {"ok": false, "message": "未配置新存档方法。"}
	var data: Variant = _factory.call()
	if not data is PackedByteArray:
		return {"ok": false, "message": "新存档方法未返回字节数据。"}
	return import_save(data)
