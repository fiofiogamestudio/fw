extends Control
## Standalone Godot host: one JSON counter, one FWB adapter, no FWC dependency.

const FileAdapter = preload("res://addons/fwb/adapters/file_save_adapter.gd")
const LIMIT := 1000000

var save_path := "user://counter.json"
var counter := 0
var started := false
var _adapter: RefCounted
var _platform: Node
var _saves: Node
var _ads: Node
var _panel: VBoxContainer
var _count: Label
var _status: Label
var _cloud_status: Label
var _paused := false
var _ad_busy := false
var _grants: Dictionary = {}


func _ready() -> void:
	_build()
	_platform = get_node("/root/FwbPlatform")
	_adapter = FileAdapter.new()
	_adapter.setup(save_path, _validate, _new_save, 4096)
	_platform.loading_complete()
	var choice: Dictionary = await _platform.open_save_screen(_adapter, {
		"gameId": "fwb-save-flow-example", "slot": "main", "title": "Save your journey",
		"subtitle": "A reusable save flow. Your game owns the progress.", "locale": "en",
		"eyebrow": "FWB / SAVE FLOW", "background": _background(),
	})
	if not is_inside_tree() or not bool(choice.get("ok", false)):
		return
	_saves = choice.get("service")
	var local: Dictionary = _adapter.get_local_snapshot()
	if not local.get("valid", false):
		_status.text = "Cannot open the local save. Restart to choose another save."
		_panel.show()
		return
	counter = int(JSON.parse_string(local.bytes.get_string_from_utf8()).count)
	_ads = _platform.create_ads_service()
	_platform.interruption_changed.connect(_on_interruption)
	if is_instance_valid(_saves):
		_saves.state_changed.connect(_on_save_state)
		_on_save_state(_saves.snapshot())
	started = true
	_panel.show()
	_refresh()
	_on_interruption(bool(_platform.interruption_state().paused), [])


func _new_save() -> PackedByteArray:
	return JSON.stringify({"version": 1, "count": 0}).to_utf8_buffer()


func _validate(data: PackedByteArray) -> Dictionary:
	var value: Variant = JSON.parse_string(data.get_string_from_utf8())
	if not value is Dictionary or value.size() != 2 or value.get("version") != 1:
		return {"ok": false, "message": "Unsupported counter save."}
	var amount: Variant = value.get("count")
	if not (amount is float or amount is int) or not is_finite(float(amount)) or float(amount) != floorf(float(amount)) or amount < 0 or amount > LIMIT:
		return {"ok": false, "message": "Invalid counter value."}
	return {"ok": true, "summary": "%d steps collected" % int(amount), "playtime": 0}


func _advance() -> void:
	if started and not _paused and not _ad_busy:
		_commit(counter + 1)


func _commit(value: int) -> bool:
	# Validate and atomically write before committing the running model.
	# Cloud/new imports only happen in open_save_screen before started becomes true.
	var bytes := JSON.stringify({"version": 1, "count": value}).to_utf8_buffer()
	var saved: Dictionary = _adapter.import_save(bytes)
	if not saved.get("ok", false):
		_status.text = "Save failed. Previous progress is unchanged."
		return false
	counter = value
	_platform.report_file_written(save_path)
	if is_instance_valid(_saves):
		_saves.notify_local_saved()
	_status.text = "Saved on this device."
	_refresh()
	return true


func _rewarded() -> void:
	if not started or _paused or _ad_busy:
		return
	_ad_busy = true
	_refresh()
	var result: Dictionary = await _ads.rewarded("bonus")
	_ad_busy = false
	var grant: Variant = result.get("grant")
	if result.get("reward_eligible") == true and grant is Dictionary and not _grants.has(str(grant.get("id", ""))) and not str(grant.get("id", "")).is_empty():
		var id := str(grant.id)
		# This sample consumes only the awaited result. It does not also grant from completed.
		if _commit(counter + 10):
			_grants[id] = true
			_status.text = "Video completed. Ten steps saved."
	else:
		_status.text = "Ad unavailable or unfinished. No bonus granted."
	_refresh()


func _on_interruption(paused: bool, _reasons: Array) -> void:
	_paused = paused
	if paused:
		_platform.gameplay_stop()
	else:
		_platform.gameplay_start()
	_refresh()


func _on_save_state(state: Dictionary) -> void:
	# Runtime state codes are translated by this host; no provider-language message leaks.
	if state.get("remote_uncertain", false):
		_cloud_status.text = "Cloud result unknown. Restart and choose a cloud save before syncing."
	elif state.get("backup_suspended", false):
		_cloud_status.text = "Cloud backup paused. Restart to choose a save again."
	elif state.get("auto_backup_active", false):
		_cloud_status.text = "Cloud backup is enabled for this session."
	else:
		_cloud_status.text = "Local progress is available without cloud or advertising."


func _refresh() -> void:
	_count.text = "%d" % counter
	for child: Node in _panel.get_children():
		if child is Button:
			child.disabled = not started or _paused or _ad_busy


func _build() -> void:
	var image := TextureRect.new()
	image.texture = _background()
	image.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	image.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(image)
	image.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var margin := MarginContainer.new()
	add_child(margin)
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right"]:
		margin.add_theme_constant_override("margin_" + side, 28)
	margin.add_theme_constant_override("margin_top", 105)
	margin.add_theme_constant_override("margin_bottom", 28)
	_panel = VBoxContainer.new()
	_panel.add_theme_constant_override("separation", 20)
	margin.add_child(_panel)
	_panel.add_child(_label("FWB / YOUR GAME", 14, Color("8ecfbe")))
	_panel.add_child(_label("Every step counts.", 30))
	_panel.add_child(_label("Close and reopen to choose this device's progress or a cloud save.", 16, Color("b7c9ce")))
	_count = _label("0", 80, Color("aff5dd"))
	_panel.add_child(_count)
	_panel.add_child(_label("STEPS COLLECTED", 13, Color("91aeb8")))
	var advance := Button.new()
	advance.name = "Advance"
	advance.text = "Take one step + save"
	advance.custom_minimum_size.y = 54
	advance.pressed.connect(_advance)
	_panel.add_child(advance)
	var reward := Button.new()
	reward.name = "Rewarded"
	reward.text = "Watch a video for +10"
	reward.custom_minimum_size.y = 50
	reward.pressed.connect(_rewarded)
	_panel.add_child(reward)
	_status = _label("Your progress is ready.", 14)
	_panel.add_child(_status)
	_cloud_status = _label("", 13, Color("91aeb8"))
	_panel.add_child(_cloud_status)
	_panel.hide()


func _background() -> GradientTexture2D:
	var gradient := Gradient.new()
	gradient.set_color(0, Color("1c4952"))
	gradient.set_color(1, Color("071219"))
	var texture := GradientTexture2D.new()
	texture.gradient = gradient
	texture.fill_from = Vector2(0.1, 0)
	texture.fill_to = Vector2(1, 1)
	return texture


func _label(text: String, size: int, color: Color = Color("eef7f5")) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", size)
	label.add_theme_color_override("font_color", color)
	return label


func _exit_tree() -> void:
	if is_instance_valid(_saves):
		_saves.dispose()
		_saves.queue_free()
	if is_instance_valid(_ads):
		_ads.dispose()
		_ads.queue_free()
	if is_instance_valid(_platform):
		_platform.gameplay_stop()
		_platform.request_storage_sync()
