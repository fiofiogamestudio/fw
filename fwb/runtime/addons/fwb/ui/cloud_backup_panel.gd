extends VBoxContainer
## Optional settings panel. It uploads the current local save; never loads game state.
## configure(service, {locale, theme, font, strings}) before adding to the tree.
signal backup_finished(result: Dictionary)

var _service: Object
var _options: Dictionary = {}
var _status: Label
var _detail: Label
var _action: Button
var _confirmation: VBoxContainer
var _confirmation_label: Label
var _confirm_action: Button
var _confirmation_target := ""
var _busy := false
var _strings: Dictionary = {}
var _last_result: Dictionary = {}

func configure(service: Object, options: Dictionary = {}) -> void:
	_service = service
	_options = options.duplicate()
	_strings = _english() if str(options.get("locale", "zh-CN")) == "en" else _chinese()
	var overrides: Variant = options.get("strings", {})
	if overrides is Dictionary:
		_strings.merge(overrides, true)
	if options.get("theme") is Theme:
		theme = options.theme
	if options.get("font") is Font:
		theme = theme.duplicate() if theme != null else Theme.new()
		theme.default_font = options.font

func _ready() -> void:
	if _strings.is_empty():
		_strings = _chinese()
	add_theme_constant_override("separation", 10)
	var heading := _label(_text("title"), 17)
	add_child(heading)
	_status = _label("", 14)
	_status.name = "BackupStatus"
	add_child(_status)
	_detail = _label(_text("explanation"), 12)
	_detail.name = "BackupDetail"
	_detail.modulate = Color(1, 1, 1, 0.75)
	add_child(_detail)
	_action = Button.new()
	_action.name = "UploadLocal"
	_action.text = _text("upload")
	_action.custom_minimum_size.y = 48
	_action.add_theme_font_size_override("font_size", 14)
	_action.pressed.connect(_request_upload)
	add_child(_action)
	_confirmation = VBoxContainer.new()
	_confirmation.name = "BackupConfirmation"
	_confirmation.add_theme_constant_override("separation", 8)
	add_child(_confirmation)
	_confirmation_label = _label("", 13)
	_confirmation.add_child(_confirmation_label)
	_confirm_action = Button.new()
	_confirm_action.name = "ConfirmBackup"
	_confirm_action.custom_minimum_size.y = 46
	_confirm_action.pressed.connect(_upload)
	_confirmation.add_child(_confirm_action)
	var cancel := Button.new()
	cancel.name = "CancelBackup"
	cancel.text = _text("cancel")
	cancel.custom_minimum_size.y = 42
	cancel.pressed.connect(_cancel_upload)
	_confirmation.add_child(cancel)
	_confirmation.hide()
	if is_instance_valid(_service):
		_service.state_changed.connect(_on_service_state_changed)
		_on_state_changed(_service.snapshot())
	else:
		_status.text = _text("unavailable")
		_action.disabled = true

func _exit_tree() -> void:
	if is_instance_valid(_service) and _service.state_changed.is_connected(_on_service_state_changed):
		_service.state_changed.disconnect(_on_service_state_changed)

func _on_service_state_changed(state: Dictionary) -> void:
	if not _busy:
		_last_result = {}
	_on_state_changed(state)

func _on_state_changed(state: Dictionary) -> void:
	if _status == null:
		return
	var busy := _busy or bool(state.get("busy", false))
	var available := bool(state.get("cloud_available", false))
	var local: Dictionary = state.get("local", {})
	var uncertain := bool(state.get("remote_uncertain", false))
	var target := str(state.get("upload_target", "new"))
	_action.disabled = busy or uncertain or not available or not bool(local.get("available", local.get("valid", false)))
	_action.text = _text("uploading") if busy else _text("upload")
	if _confirmation.visible and (_confirmation_target != target or _action.disabled):
		_cancel_upload()
	var message := str(state.get("message", ""))
	var error := str(state.get("error", ""))
	var status := str(state.get("status", ""))
	if busy:
		_status.text = _text("uploading")
	elif not available:
		_status.text = _text("unavailable")
	elif uncertain:
		_status.text = _text("unknown_result")
	elif not _last_result.is_empty():
		_status.text = _text("uploaded") if bool(_last_result.get("ok", false)) else str(_last_result.get("message", _text("failed")))
	elif not error.is_empty():
		_status.text = error
	elif not message.is_empty():
		_status.text = message
	elif status == "uploaded":
		_status.text = _text("uploaded")
	else:
		_status.text = _text("ready")
	var retry_ms := int(state.get("retry_after_ms", _last_result.get("retry_after_ms", 0)))
	if retry_ms > 0 and not busy:
		_status.text += "\n" + (_text("rate_limit") % maxi(1, int(ceil(retry_ms / 1000.0))))
	_detail.text = _text("explanation")
	if bool(state.get("auto_backup_active", false)):
		_detail.text += "\n" + _text("auto_session")
	elif bool(state.get("backup_suspended", false)) and not uncertain:
		_detail.text += "\n" + _text("restore_auto")

func _request_upload() -> void:
	if _busy or _action.disabled:
		return
	_confirmation_target = str(_service.snapshot().get("upload_target", "new"))
	_confirmation_label.text = _text("confirm_update") if _confirmation_target == "selected" else _text("confirm_new")
	_confirm_action.text = _text("update") if _confirmation_target == "selected" else _text("create")
	_confirmation.show()
	_confirm_action.grab_focus()

func _cancel_upload() -> void:
	_confirmation.hide()
	_confirmation_target = ""

func _upload() -> void:
	if _busy or not is_instance_valid(_service) or _action.disabled:
		return
	var current: Dictionary = _service.snapshot()
	if bool(current.get("remote_uncertain", false)) or _confirmation_target.is_empty():
		_cancel_upload()
		return
	if _confirmation_target != str(current.get("upload_target", "new")):
		_cancel_upload()
		_on_state_changed(current)
		return
	_cancel_upload()
	_busy = true
	_last_result = {}
	_on_state_changed(_service.snapshot())
	var result: Dictionary = await _service.upload_local()
	if not is_inside_tree():
		return
	_busy = false
	_last_result = result.duplicate(true)
	_on_state_changed(_service.snapshot())
	backup_finished.emit(result)

func _label(value: String, font_size: int) -> Label:
	var label := Label.new()
	label.text = value
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", font_size)
	return label

func _text(key: String) -> String:
	return str(_strings.get(key, key))

func _chinese() -> Dictionary:
	return {"title": "云端备份", "upload": "备份当前进度到云端", "uploading": "正在备份，请稍候…", "ready": "可以手动备份当前本地进度。",
		"cancel": "取消", "create": "新建云备份", "update": "更新所选云备份", "confirm_new": "将新建一份云端备份，已有云端存档会保留。", "confirm_update": "当前进度将覆盖本次选择的云端存档。确认更新？",
		"explanation": "已读取的云档会更新；未选择云档时会新建备份。此操作不改变当前游戏进度。",
		"auto_session": "本局已选择自动备份；切到后台后需要重新确认。", "restore_auto": "恢复自动备份需重新打开游戏并选择存档；现在仍可手动新建备份。",
		"unavailable": "当前环境无法使用云端备份，本地存档仍可使用。", "uploaded": "已备份到云端。", "failed": "备份未完成，请稍后重试。",
		"unknown_result": "上次备份结果未确认，上传已暂停。请重新打开游戏并选择存档，核对云端结果。", "rate_limit": "请至少等待 %d 秒后重试。"}

func _english() -> Dictionary:
	return {"title": "Cloud backup", "upload": "Back up current progress", "uploading": "Backing up…", "ready": "You can back up your current local progress.",
		"cancel": "Cancel", "create": "Create cloud backup", "update": "Update chosen cloud save", "confirm_new": "Create a new backup and keep all existing cloud saves.", "confirm_update": "Current progress will overwrite the cloud save chosen this session. Continue?",
		"explanation": "A loaded cloud save is updated. Otherwise a new backup is created. Current gameplay is unchanged.",
		"auto_session": "Automatic backup was selected for this session. Going to the background revokes that consent.", "restore_auto": "Reopen the game and choose a save to restore automatic backup. A manual new backup is still available.",
		"unavailable": "Cloud backup is unavailable here. Your local save remains usable.", "uploaded": "Backed up to the cloud.", "failed": "Backup did not finish. Try again later.",
		"unknown_result": "The last backup result is unknown. Uploads are paused. Reopen the game and choose a save to check the cloud result.", "rate_limit": "Wait at least %d seconds before retrying."}
