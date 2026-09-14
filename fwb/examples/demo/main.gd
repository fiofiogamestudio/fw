extends Control

const SAVE_PATH := "user://progress.json"
const INK := Color("edf4ff")
const MUTED := Color("a4b4ca")
const CYAN := Color("6be6d5")
const GOLD := Color("ffc582")

var config: Dictionary = {}
var energy := 0
var deliveries := 0
var collected := 0
var reward_count := 0
var active := false
var ad_busy := false
var background := false
var saved_note := "尚无存档，开始新的补给任务"
var events: Array[String] = []
var score_label: Label
var mission_label: Label
var status_label: Label
var sdk_label: Label
var save_label: Label
var log_label: Label
var progress: ProgressBar
var collect_button: Button
var pause_button: Button
var ad_button: Button
var audio_player: AudioStreamPlayer


func _ready() -> void:
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://data/game.json"))
	if parsed is Dictionary:
		config = parsed
	_restore()
	_create_audio()
	_create_ui()
	FwbPlatform.lifecycle_changed.connect(_on_lifecycle)
	FwbPlatform.sdk_error.connect(func(result: Dictionary): _log("SDK 事件失败：" + str(result.get("message", ""))))
	_refresh()
	_log("配置已读取 · 每 %d 格能量完成一次补给" % int(config.get("mission_energy", 12)))
	await FwbPlatform.initialize()
	FwbPlatform.loading_complete()
	_refresh()
	_log(FwbPlatform.sdk_message)
	print("FWB_DEMO_READY ", JSON.stringify({"config_loaded": not config.is_empty(), "energy": energy, "deliveries": deliveries, "platform": FwbPlatform.platform, "sdk": FwbPlatform.sdk_status}))


func _draw() -> void:
	draw_circle(Vector2(size.x - 75, 120), 220, Color(0.05, 0.15, 0.22, 0.4))
	draw_arc(Vector2(size.x - 75, 120), 240, 0, TAU, 90, Color(0.23, 0.47, 0.54, 0.14), 1.0, true)
	for index in range(36):
		var position := Vector2(fmod(index * 137.0 + 43.0, size.x), fmod(index * 83.0 + 27.0, size.y))
		draw_circle(position, 1.2, Color(0.56, 0.76, 0.9, 0.19))


func _create_ui() -> void:
	var ui_theme := Theme.new()
	var font_path := "res://assets/starport-font.ttf"
	if ResourceLoader.exists(font_path):
		ui_theme.default_font = load(font_path)
	else:
		var system_font := SystemFont.new()
		system_font.font_names = PackedStringArray(["Noto Sans SC", "Microsoft YaHei", "sans-serif"])
		ui_theme.default_font = system_font
	ui_theme.default_font_size = 18
	theme = ui_theme
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 36)
	add_child(margin)
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 14)
	margin.add_child(page)
	var masthead := HBoxContainer.new()
	page.add_child(masthead)
	_label(masthead, "FWB  /  FLIGHT CHECK", 16, CYAN).size_flags_horizontal = Control.SIZE_EXPAND_FILL
	status_label = _label(masthead, "准备就绪", 16, MUTED)
	_label(page, str(config.get("title", "星港补给站")), 38, INK)
	_label(page, "收集能量，点亮航线。你的补给进度会留在这台设备上。", 18, MUTED)
	var columns := HBoxContainer.new()
	columns.add_theme_constant_override("separation", 20)
	columns.size_flags_vertical = Control.SIZE_EXPAND_FILL
	page.add_child(columns)
	var game_panel := _panel(columns)
	game_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var game := _panel_content(game_panel)
	_label(game, "01   /   能量补给", 15, CYAN)
	mission_label = _label(game, "", 24, INK)
	score_label = _label(game, "00 / 12", 58, INK)
	progress = ProgressBar.new()
	progress.custom_minimum_size.y = 14
	progress.show_percentage = false
	progress.add_theme_stylebox_override("background", _box(Color("213348"), 7))
	progress.add_theme_stylebox_override("fill", _box(CYAN, 7))
	game.add_child(progress)
	_label(game, "点击或触摸收集 · 每次 +1 能量", 16, MUTED)
	collect_button = _button(game, "收集能量  +1", true)
	collect_button.custom_minimum_size.y = 64
	collect_button.pressed.connect(_collect)
	var actions := HBoxContainer.new()
	actions.add_theme_constant_override("separation", 12)
	game.add_child(actions)
	pause_button = _button(actions, "开始任务", false)
	pause_button.pressed.connect(_toggle_pause)
	var reset_button := _button(actions, "重置演示存档", false)
	reset_button.pressed.connect(_reset)
	var aside_panel := _panel(columns)
	aside_panel.custom_minimum_size.x = 350
	var aside := _panel_content(aside_panel)
	_label(aside, "02   /   渠道与奖励", 15, GOLD)
	sdk_label = _label(aside, "", 18, INK)
	sdk_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	ad_button = _button(aside, "观看广告 · 获得 +3 能量", false)
	ad_button.pressed.connect(_try_ad)
	var notice := _label(aside, "仅在平台确认广告奖励后发放。\n预览或 SDK 不可用时不会获得奖励。", 15, MUTED)
	notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var spacer := Control.new()
	spacer.custom_minimum_size.y = 12
	aside.add_child(spacer)
	_label(aside, "最近事件", 15, GOLD)
	log_label = _label(aside, "", 15, MUTED)
	log_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	log_label.size_flags_vertical = Control.SIZE_EXPAND_FILL
	save_label = _label(page, "", 15, MUTED)
	_label(page, "FWB BUILD LAB    /    GDScript · Compatibility · 单线程 Web", 13, Color("71849f"))


func _panel(parent: Node) -> PanelContainer:
	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override("panel", _box(Color("101e32"), 20, Color("26384d")))
	parent.add_child(panel)
	return panel


func _panel_content(panel: PanelContainer) -> VBoxContainer:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	panel.add_child(box)
	return box


func _box(color: Color, radius: int, border: Color = Color.TRANSPARENT) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.set_corner_radius_all(radius)
	style.set_content_margin_all(20 if border.a > 0 else 10)
	style.border_color = border
	style.set_border_width_all(1 if border.a > 0 else 0)
	return style


func _label(parent: Node, text_value: String, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.text = text_value
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	parent.add_child(label)
	return label


func _button(parent: Node, text_value: String, primary: bool) -> Button:
	var button := Button.new()
	button.text = text_value
	button.custom_minimum_size.y = 48
	button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	button.add_theme_stylebox_override("normal", _box(CYAN if primary else Color("213348"), 10))
	button.add_theme_stylebox_override("hover", _box(Color("a4ffea") if primary else Color("314d65"), 10))
	button.add_theme_stylebox_override("pressed", _box(Color("48b9ab") if primary else Color("192b41"), 10))
	button.add_theme_color_override("font_color", Color("0c2831") if primary else INK)
	button.add_theme_color_override("font_hover_color", Color("0c2831") if primary else INK)
	button.add_theme_color_override("font_pressed_color", Color("0c2831") if primary else INK)
	button.add_theme_font_size_override("font_size", 17)
	parent.add_child(button)
	return button


func _collect() -> void:
	if ad_busy or background:
		return
	if not active:
		active = true
		FwbPlatform.gameplay_start()
	_gain_energy(1)
	audio_player.play()
	_log("收集 +1 能量")
	_refresh()
	print("FWB_DEMO_STATE ", JSON.stringify({"energy": energy, "deliveries": deliveries, "collected": collected, "rewards": reward_count}))


func _gain_energy(amount: int) -> void:
	energy += amount
	collected += amount
	var required := int(config.get("mission_energy", 12))
	while energy >= required:
		energy -= required
		deliveries += 1
		_log("补给完成！航线 %02d 已点亮" % deliveries)
	_save()


func _toggle_pause() -> void:
	if ad_busy or background:
		return
	active = not active
	if active:
		FwbPlatform.gameplay_start()
	else:
		FwbPlatform.gameplay_stop()
	_log("任务继续" if active else "任务已暂停")
	_refresh()


func _try_ad() -> void:
	if ad_busy or background:
		return
	ad_busy = true
	var resume_play := active
	FwbPlatform.gameplay_stop()
	audio_player.stop()
	_refresh()
	_log("请求激励广告，等待平台结果")
	var result: Dictionary = await FwbPlatform.request_rewarded_ad()
	if result.get("status") == "success" and result.get("reward_eligible") == true and not result.get("simulated", true):
		reward_count += 1
		_gain_energy(int(config.get("reward_energy", 3)))
		_log("平台确认奖励：+3 能量")
	else:
		_log("广告结果：%s · 未发奖励" % str(result.get("status", "error")))
	ad_busy = false
	if resume_play and not background:
		FwbPlatform.gameplay_start()
	_refresh()
	print("FWB_AD_RESULT ", JSON.stringify(result))


func _on_lifecycle(event: String) -> void:
	if event == "background":
		background = true
		FwbPlatform.gameplay_stop()
		audio_player.stop()
		_save()
		_log("已切到后台 · 进度已保存")
	elif event == "foreground":
		background = false
		if active and not ad_busy:
			FwbPlatform.gameplay_start()
		_log("已回到前台")
	elif event == "ad_started":
		audio_player.stop()
	_refresh()


func _refresh() -> void:
	var required := int(config.get("mission_energy", 12))
	mission_label.text = "下一条航线  /  %02d" % (deliveries + 1)
	score_label.text = "%02d / %02d" % [energy, required]
	progress.max_value = required
	progress.value = energy
	status_label.text = "后台暂停" if background else ("等待广告结果" if ad_busy else ("任务进行中" if active else "待命 · 点击收集开始"))
	pause_button.text = "暂停任务" if active else "开始任务"
	collect_button.disabled = ad_busy or background
	pause_button.disabled = ad_busy or background
	ad_button.disabled = ad_busy or background
	sdk_label.text = "平台  %s\nSDK  %s" % [FwbPlatform.platform, FwbPlatform.sdk_status]
	save_label.text = "已完成 %d 次补给  ·  累计 %d 能量  ·  广告奖励 %d 次\n%s" % [deliveries, collected, reward_count, saved_note]


func _log(event: String) -> void:
	events.push_front(event)
	if events.size() > 4:
		events.resize(4)
	if log_label != null:
		log_label.text = "\n\n".join(events)


func _restore() -> void:
	if not FileAccess.file_exists(SAVE_PATH):
		return
	var saved: Variant = JSON.parse_string(FileAccess.get_file_as_string(SAVE_PATH))
	if not saved is Dictionary or int(saved.get("schema", 0)) != int(config.get("save_schema", 1)):
		saved_note = "存档格式不兼容，已使用新任务"
		return
	energy = clampi(int(saved.get("energy", 0)), 0, int(config.get("mission_energy", 12)) - 1)
	deliveries = maxi(int(saved.get("deliveries", 0)), 0)
	collected = maxi(int(saved.get("collected", 0)), 0)
	reward_count = maxi(int(saved.get("reward_count", 0)), 0)
	saved_note = "已恢复本机存档 · 继续你的上一段航线"


func _save() -> void:
	var file := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if file == null:
		saved_note = "存档失败：%s" % error_string(FileAccess.get_open_error())
		return
	file.store_string(JSON.stringify({"schema": int(config.get("save_schema", 1)), "energy": energy,
		"deliveries": deliveries, "collected": collected, "reward_count": reward_count}))
	file.close()
	saved_note = "已保存到本机 · 刷新页面可恢复进度"
	if OS.has_feature("web") and not OS.is_userfs_persistent():
		saved_note = "当前浏览器不支持持久存档，关闭后可能丢失"


func _reset() -> void:
	if ad_busy:
		return
	energy = 0
	deliveries = 0
	collected = 0
	reward_count = 0
	active = false
	FwbPlatform.gameplay_stop()
	_save()
	_log("演示存档已重置")
	_refresh()


func _create_audio() -> void:
	# A short generated chime is an audio asset with no external dependency.
	var sample_rate := 22050
	var sample_count := int(sample_rate * 0.12)
	var samples := PackedByteArray()
	samples.resize(sample_count * 2)
	for sample in range(sample_count):
		var time := float(sample) / sample_rate
		var fade := pow(1.0 - float(sample) / sample_count, 2.0)
		var value := int(sin(TAU * 660.0 * time) * fade * 6500.0)
		samples.encode_s16(sample * 2, value)
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = sample_rate
	stream.data = samples
	audio_player = AudioStreamPlayer.new()
	audio_player.stream = stream
	add_child(audio_player)
