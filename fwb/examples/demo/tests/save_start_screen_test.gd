extends SceneTree

const Screen = preload("res://addons/fwb/ui/save_start_screen.gd")
const BackupPanel = preload("res://addons/fwb/ui/cloud_backup_panel.gd")
var checks := 0
var failures := 0
var results: Array = []

class FakeService extends RefCounted:
	signal state_changed(value: Dictionary)
	var tree: SceneTree
	var initialize_calls := 0
	var refresh_calls := 0
	var choices: Array = []
	var fail_choice := false
	var upload_calls := 0
	var publish_upload_result := true
	var upload_result := {"ok": true, "status": "uploaded"}
	var state := {
		"local": {"exists": true, "available": true, "valid": true, "label": "本地存档", "summary": "Level 1 · 补给营地\n已探索 12 个地点", "updated_at": "2026-10-08 09:24"},
		"clouds": [{"id": "cloud-1", "label": "云端进度", "summary": "Level 0 · 无尽走廊", "updated_at": "2026-10-07 22:18"}],
		"cloud_available": true, "loading": true, "busy": true, "error": "", "status": "loading"
	}
	func snapshot() -> Dictionary:
		return state.duplicate(true)
	func initialize() -> Dictionary:
		initialize_calls += 1
		await tree.process_frame
		state.loading = false
		state.busy = false
		state_changed.emit(snapshot())
		return {"ok": true}
	func refresh() -> Dictionary:
		refresh_calls += 1
		state.loading = true
		state.busy = true
		state_changed.emit(snapshot())
		await tree.process_frame
		state.loading = false
		state.busy = false
		state.error = ""
		state_changed.emit(snapshot())
		return {"ok": true}
	func choose_local(backup: bool = false) -> Dictionary:
		return _choice("local", {"auto_backup": backup})
	func choose_new(confirmed: bool = false, backup: bool = false) -> Dictionary:
		return _choice("new", {"confirmed": confirmed, "auto_backup": backup})
	func choose_cloud(id: String, backup: bool = false) -> Dictionary:
		state.busy = true
		state_changed.emit(snapshot())
		await tree.process_frame
		state.busy = false
		return _choice("cloud", {"id": id, "auto_backup": backup})
	func _choice(kind: String, details: Dictionary) -> Dictionary:
		details.kind = kind
		choices.append(details)
		return {"ok": not fail_choice, "status": "test", "selection": details}
	func upload_local() -> Dictionary:
		upload_calls += 1
		state.busy = true
		state_changed.emit(snapshot())
		await tree.process_frame
		state.busy = false
		if not publish_upload_result:
			return upload_result
		state.status = upload_result.status
		state.error = str(upload_result.get("message", "")) if not upload_result.ok else ""
		state_changed.emit(snapshot())
		return upload_result

func _initialize() -> void:
	_run.call_deferred()

func _check(value: bool, message: String) -> void:
	checks += 1
	if not value:
		failures += 1
		push_error("SAVE_SCREEN_TEST: " + message)

func _make(service: FakeService, options: Dictionary = {}) -> Control:
	service.tree = self
	var screen := Screen.new()
	var settings := {"title": "后室：无尽迷途", "safe_insets": Vector4.ZERO}
	settings.merge(options, true)
	screen.configure(service, settings)
	screen.completed.connect(func(result: Dictionary): results.append(result))
	root.add_child(screen)
	return screen

func _release(screen: Control) -> void:
	screen.queue_free()
	await process_frame
	await process_frame

func _run() -> void:
	# Geometry assertions use logical pixels at each requested window size.
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_DISABLED
	root.content_scale_size = Vector2i.ZERO
	root.size = Vector2i(390, 844)
	for argument in OS.get_cmdline_user_args():
		if argument == "--render":
			await _render()
			quit(0 if failures == 0 else 1)
			return
	var service := FakeService.new()
	var screen := _make(service)
	_check(not screen.find_child("ContinueLocal", true, false).disabled, "local remains usable while cloud list loads")
	_check(not screen.find_child("AutoBackup", true, false).button_pressed, "automatic upload requires opt-in")
	_check(screen.find_child("LocalSaveTitle", true, false).text == "本地进度", "local summary is not repeated as the card heading")
	await process_frame
	await process_frame
	_check(service.initialize_calls == 1 and service.refresh_calls == 0, "each screen initializes exactly once")
	screen.find_child("UseCloud_cloud-1", true, false).pressed.emit()
	_check(screen.find_child("ConfirmOverwrite", true, false).visible, "cloud overwrite requires confirmation")
	_check(service.choices.is_empty(), "opening confirmation does not mutate saves")
	_check(screen.find_child("ContinueLocal", true, false).focus_mode == Control.FOCUS_NONE, "modal blocks background keyboard focus")
	service.state_changed.emit(service.snapshot())
	_check(screen.find_child("ContinueLocal", true, false).focus_mode == Control.FOCUS_NONE, "asynchronous status refresh preserves modal focus trap")
	screen.find_child("CancelOverwrite", true, false).pressed.emit()
	_check(service.choices.is_empty(), "cancel preserves local save")
	_check(screen.find_child("ContinueLocal", true, false).focus_mode == Control.FOCUS_ALL, "cancel restores keyboard focusability")
	screen.find_child("AutoBackup", true, false).button_pressed = true
	screen.find_child("UseCloud_cloud-1", true, false).pressed.emit()
	screen.find_child("AcceptOverwrite", true, false).pressed.emit()
	_check(screen.find_child("ContinueLocal", true, false).disabled, "cloud import disables duplicate selection")
	await process_frame
	await process_frame
	_check(service.choices.size() == 1 and service.choices[0].id == "cloud-1" and service.choices[0].auto_backup, "cloud and session backup choice delegated")
	_check(results.size() == 1 and results[0].selection.kind == "cloud", "successful selection completes once")
	await _release(screen)
	service = FakeService.new()
	screen = _make(service)
	await process_frame
	await process_frame
	screen.find_child("StartNew", true, false).pressed.emit()
	_check(service.choices.is_empty() and screen.find_child("ConfirmOverwrite", true, false).visible, "new game protects existing local save")
	screen.find_child("AcceptOverwrite", true, false).pressed.emit()
	_check(service.choices.size() == 1 and service.choices[0].confirmed, "new game receives explicit confirmation")
	await _release(screen)
	service = FakeService.new()
	service.state.local = {"exists": false, "available": false}
	service.state.cloud_available = false
	service.state.clouds = []
	screen = _make(service)
	await process_frame
	await process_frame
	_check(not screen.find_child("AutoBackup", true, false).visible, "unsupported platforms do not offer cloud opt-in")
	screen.find_child("StartNew", true, false).pressed.emit()
	_check(service.choices.size() == 1 and not service.choices[0].confirmed, "empty local new game needs no overwrite dialog")
	await _release(screen)
	service = FakeService.new()
	service.state.error = "NETWORK_TIMEOUT"
	screen = _make(service)
	await process_frame
	await process_frame
	_check(not screen.find_child("ContinueLocal", true, false).disabled, "network error allows local continuation")
	_check("重试" in screen.find_child("CloudStatus", true, false).text, "network error offers recovery")
	screen.find_child("RefreshCloud", true, false).pressed.emit()
	await process_frame
	await process_frame
	_check(service.refresh_calls == 1 and service.state.error == "", "refresh retries service")
	service.fail_choice = true
	var completed_before := results.size()
	screen.find_child("ContinueLocal", true, false).pressed.emit()
	_check(results.size() == completed_before and not screen.find_child("ContinueLocal", true, false).disabled, "failed choice does not complete or trap input")
	await _release(screen)
	await _test_game_theme()
	await _test_cover_layout()
	await _test_cover_rows()
	await _test_backup_panel()
	print("SAVE_SCREEN_TEST: %d checks, %d failures" % [checks, failures])
	quit(0 if failures == 0 else 1)

func _test_game_theme() -> void:
	var game_theme := Theme.new()
	var normal := StyleBoxFlat.new()
	normal.bg_color = Color("171a16")
	normal.content_margin_top = 3
	var primary := StyleBoxFlat.new()
	primary.bg_color = Color("303426")
	game_theme.set_stylebox("normal", "Button", normal)
	game_theme.set_color("font_color", "Button", Color("ede9dc"))
	game_theme.set_font_size("font_size", "Button", 17)
	game_theme.set_type_variation("JourneyPrimary", "Button")
	game_theme.set_stylebox("normal", "JourneyPrimary", primary)
	var service := FakeService.new()
	var screen := _make(service, {
		"theme": game_theme, "primaryButtonVariation": "JourneyPrimary", "cornerRadius": 2,
		"palette": {"ink": Color("ede9dc"), "muted": "#b2afa1", "surface": "#171a16", "border": "#484b41", "warning": "#d68d74"}
	})
	await process_frame
	await process_frame
	var continue_button: Button = screen.find_child("ContinueLocal", true, false)
	var new_button: Button = screen.find_child("StartNew", true, false)
	_check(continue_button.get_theme_stylebox("normal") == primary and new_button.get_theme_stylebox("normal") == normal, "game theme supplies distinct primary and regular button styles")
	_check(continue_button.get_theme_color("font_color") == Color("ede9dc") and continue_button.get_theme_font_size("font_size") == 17, "game theme font and color are inherited by primary variation")
	_check(not continue_button.has_theme_stylebox_override("normal") and not new_button.has_theme_stylebox_override("normal"), "custom game styles are not hidden by the framework skin")
	_check(normal.content_margin_top == 3, "shared game theme resources are not mutated")
	var title: Label = screen.find_child("LocalSaveTitle", true, false)
	var panel_style: StyleBoxFlat = title.get_parent().get_parent().get_theme_stylebox("panel")
	_check(title.get_theme_color("font_color") == Color("ede9dc") and panel_style.bg_color == Color("171a16") and panel_style.corner_radius_top_left == 2, "palette accepts Color and HTML values for text and panels")
	service.state.error = "NETWORK_TIMEOUT"
	service.state_changed.emit(service.snapshot())
	_check(screen.find_child("CloudStatus", true, false).get_theme_color("font_color") == Color("d68d74"), "state changes retain the game warning color")
	screen.find_child("StartNew", true, false).pressed.emit()
	_check(screen.find_child("AcceptOverwrite", true, false).get_theme_stylebox("normal") == primary, "confirmation actions reuse the game primary variation")
	await _release(screen)
	service = FakeService.new()
	screen = _make(service, {"theme": game_theme})
	await process_frame
	await process_frame
	_check(screen.find_child("ContinueLocal", true, false).get_theme_stylebox("normal") == normal, "missing optional primary variation falls back to the game Button theme")
	await _release(screen)
	service = FakeService.new()
	screen = _make(service, {"font": SystemFont.new()})
	await process_frame
	await process_frame
	var fallback_style: StyleBoxFlat = screen.find_child("ContinueLocal", true, false).get_theme_stylebox("normal")
	_check(fallback_style.bg_color == Color("91d4c4") and fallback_style.corner_radius_top_left == 12, "font-only consumers retain the original default skin")
	await _release(screen)

func _test_cover_layout() -> void:
	root.size = Vector2i(320, 568)
	var service := FakeService.new()
	service.state.clouds[0].summary = "Level 0 · 无尽走廊\n已探索 12 个地点"
	var screen := _make(service, {
		"layout": "cover", "title": "后室", "subtitle": "无尽迷途", "eyebrow": "",
		"sourceTabVariation": "GameSaveTab",
		"coverPageMinHeight": 176,
		"showTimestamps": false, "panelPadding": 16,
		"fontSizes": {"eyebrow": 12, "title": 24, "subtitle": 18, "section": 16, "saveTitle": 16,
			"body": 16, "meta": 12, "button": 14, "confirmationTitle": 18, "confirmationBody": 16}
	})
	_check(screen.find_child("LocalSaves", true, false).visible and not screen.find_child("CloudSaves", true, false).visible, "cover opens on local progress")
	_check(not screen.find_child("ContinueLocal", true, false).disabled, "cover permits local choice during initial cloud load")
	await process_frame
	await process_frame
	await process_frame
	_check(not screen.find_child("LocalSaveTitle", true, false).visible and not screen.find_child("SaveFooter", true, false).visible, "cover omits duplicate local heading and generic footer")
	_check(screen._details(service.state.local) == service.state.local.summary, "timestamp display can be disabled without changing save metadata")
	_check(screen.find_child("SaveTitle", true, false).get_theme_font_size("font_size") == 24 and screen.find_child("SaveSubtitle", true, false).get_theme_font_size("font_size") == 18, "cover narrow viewport honors explicit typography roles")
	_check(screen.find_child("AutoBackup", true, false).size.y >= 48 and screen.find_child("StartNew", true, false).size.y >= 48, "secondary action and checkbox meet minimum touch height")
	_check(screen.find_child("CoverSpacer", true, false).size.y >= 96, "cover reserves a visible background region")
	_check(screen.find_child("LocalSourceTab", true, false).theme_type_variation == "GameSaveTab", "cover source navigation accepts a separate game theme variation")
	var local_tab_y: float = screen.find_child("LocalSourceTab", true, false).global_position.y
	screen.find_child("ContinueLocal", true, false).grab_focus()
	service.state_changed.emit(service.snapshot())
	service.state_changed.emit(service.snapshot())
	await process_frame
	await process_frame
	_check(root.gui_get_focus_owner() == screen.find_child("ContinueLocal", true, false), "deferred focus resolves the live replacement after repeated row rebuilds")
	screen.find_child("CloudSourceTab", true, false).pressed.emit()
	_check(service.choices.is_empty() and screen.find_child("CloudSaves", true, false).visible and not screen.find_child("LocalSaves", true, false).visible, "cloud tab only changes display without importing")
	await process_frame
	await process_frame
	await process_frame
	var first_cloud: Button = screen.find_child("UseCloud_cloud-1", true, false)
	var first_region: ScrollContainer = screen.find_child("CloudSaveScroll", true, false)
	_check(not screen.find_child("CloudStatus", true, false).visible and screen.find_child("RefreshCloud", true, false).get_parent().name == "SaveSourceTabs", "ready cover cloud list omits duplicate guidance and keeps refresh beside source tabs")
	_check(first_region.scroll_vertical == 0 and first_cloud.get_global_rect().position.y >= first_region.get_global_rect().position.y and first_cloud.get_global_rect().end.y <= first_region.get_global_rect().end.y, "first cloud load button is fully visible without scrolling")
	service.state.clouds = []
	for index in range(8):
		service.state.clouds.append({"id": "cloud-%d" % index, "label": "存档 %d" % index, "summary": "Level 1 · 补给营地"})
	service.state_changed.emit(service.snapshot())
	await process_frame
	await process_frame
	await process_frame
	var scroll: ScrollContainer = screen.find_child("CloudSaveScroll", true, false)
	_check(scroll.size.y >= 144 and scroll.get_v_scroll_bar().max_value > scroll.size.y, "many cloud saves remain in a usable inner scrolling region")
	_check(is_equal_approx(local_tab_y, screen.find_child("LocalSourceTab", true, false).global_position.y), "cloud list length does not shift cover source tabs")
	var last_cloud: Button = screen.find_child("UseCloud_cloud-7", true, false)
	scroll.ensure_control_visible(last_cloud)
	await process_frame
	await process_frame
	_check(last_cloud.get_global_rect().end.y <= root.size.y and last_cloud.get_global_rect().position.y >= 0, "last cloud save is reachable in small viewport")
	last_cloud.pressed.emit()
	_check(screen.find_child("ConfirmOverwrite", true, false).visible and screen.find_child("LocalSourceTab", true, false).focus_mode == Control.FOCUS_NONE, "cover overwrite confirmation traps source tab focus")
	_check(screen.find_child("ConfirmationTitle", true, false).get_theme_font_size("font_size") == 18 and screen.find_child("ConfirmationBody", true, false).get_theme_font_size("font_size") == 16, "confirmation uses the host typography roles")
	service.state_changed.emit(service.snapshot())
	_check(root.gui_get_focus_owner() == screen.find_child("CancelOverwrite", true, false), "async cloud updates preserve cancellation focus")
	screen.find_child("CancelOverwrite", true, false).pressed.emit()
	_check(service.choices.is_empty(), "cancelling cloud import leaves local save untouched")
	screen.find_child("LocalSourceTab", true, false).pressed.emit()
	screen.find_child("RefreshCloud", true, false).pressed.emit()
	_check(not screen.find_child("ContinueLocal", true, false).disabled and screen.find_child("LocalSaves", true, false).visible, "cloud refresh preserves usable local tab")
	_check(screen.find_child("CloudStatus", true, false).visible and screen.find_child("RefreshCloud", true, false).disabled, "cover keeps loading feedback and blocks repeated refresh")
	await process_frame
	await process_frame
	service.state.cloud_available = false
	service.state.clouds = []
	service.state_changed.emit(service.snapshot())
	await process_frame
	await process_frame
	await process_frame
	var offline_tab_y: float = screen.find_child("LocalSourceTab", true, false).global_position.y
	screen.find_child("CloudSourceTab", true, false).pressed.emit()
	await process_frame
	await process_frame
	_check(screen.find_child("CloudStatus", true, false).is_visible_in_tree() and not screen.find_child("LocalSourceTab", true, false).disabled, "offline cloud tab retains a visible return to local play")
	_check(is_equal_approx(offline_tab_y, screen.find_child("LocalSourceTab", true, false).global_position.y), "short offline cloud state retains the same source tab position")
	screen.find_child("LocalSourceTab", true, false).pressed.emit()
	service.fail_choice = true
	screen.find_child("ContinueLocal", true, false).pressed.emit()
	_check(screen.find_child("SelectionStatus", true, false).is_visible_in_tree() and not screen.find_child("SelectionStatus", true, false).text.is_empty(), "failed local choice is explained in the visible cover tab")
	_check(not screen.find_child("ContinueLocal", true, false).disabled, "failed cover choice can be retried")
	await _release(screen)
	root.size = Vector2i(390, 844)

func _test_cover_rows() -> void:
	root.size = Vector2i(390, 844)
	var service := FakeService.new()
	service.state.cloud_available = false
	service.state.clouds = []
	var brand := GradientTexture2D.new()
	brand.gradient = Gradient.new()
	var screen := _make(service, {
		"layout": "cover", "sourceLayout": "rows", "brandTexture": brand,
		"brandWidth": 144, "brandHeight": 124, "coverTopInsetRatio": 0.09,
		"showLocalDetails": false, "sourceRowVariation": "GameSaveRow",
		"secondaryButtonVariation": "GameTextAction", "secondaryActionCentered": true,
		"fontSizes": {"section": 16, "button": 14, "primaryButton": 16, "sourceRowText": 14, "body": 16, "saveTitle": 16, "meta": 12},
		"localRowSummary": func(record: Dictionary) -> String:
			record.summary = "view-only mutation"
			return "第 12 天"
	})
	await process_frame
	await process_frame
	await process_frame
	var logo: TextureRect = screen.find_child("SaveBrand", true, false)
	_check(logo.texture == brand and logo.size == Vector2(144, 124) and not screen.find_child("SaveTitle", true, false).visible and not screen.find_child("SaveSubtitle", true, false).visible, "rows use the supplied brand texture without duplicate text title")
	var local: Button = screen.find_child("LocalSourceTab", true, false)
	var cloud: Button = screen.find_child("CloudSourceTab", true, false)
	_check(local.size == Vector2(350, 48) and cloud.size == Vector2(350, 48) and cloud.global_position.y > local.global_position.y, "rows stack two full-width 48 pixel save sources")
	_check(local.find_child("SourceSummary", true, false).text == "第 12 天" and cloud.find_child("SourceSummary", true, false).text == "未连接" and service.state.local.summary != "view-only mutation", "row summaries format copied local data and expose cloud status")
	_check(screen.find_child("LocalSaveDetails", true, false) == null and screen.find_child("LocalSaves", true, false).size.y == 104, "row layout keeps only two actions with no inherited fixed-height hole")
	var primary: Button = screen.find_child("ContinueLocal", true, false)
	var secondary: Button = screen.find_child("StartNew", true, false)
	_check(primary.size.x == 350 and secondary.size.x < primary.size.x and secondary.size.y >= 48 and secondary.theme_type_variation == "GameTextAction", "row secondary action is centered independently from the full-width primary action")
	_check(primary.get_theme_font_size("font_size") == 16 and secondary.get_theme_font_size("font_size") == 14, "primary button typography is independent from secondary and source labels")
	_check(is_equal_approx(primary.global_position.y - cloud.get_global_rect().end.y, 16) and is_equal_approx(844 - secondary.get_global_rect().end.y, 24), "row actions follow source rows by 16 pixels and sit 24 pixels above the bottom")
	cloud.pressed.emit()
	_check(service.choices.is_empty() and screen.find_child("CloudSaves", true, false).visible, "row source selection opens its page without importing saves")
	root.size = Vector2i(320, 568)
	service.state.cloud_available = true
	service.state.clouds = []
	for index in range(3):
		service.state.clouds.append({"id": "row-%d" % index, "label": "云端进度", "summary": "Level 0 · 无尽走廊\n已探索 12 个地点"})
	service.state_changed.emit(service.snapshot())
	screen.find_child("AutoBackup", true, false).button_pressed = true
	await process_frame
	await process_frame
	await process_frame
	var region: ScrollContainer = screen.find_child("CloudSaveScroll", true, false)
	var first_cloud: Button = screen.find_child("UseCloud_row-0", true, false)
	_check(not logo.is_visible_in_tree() and not cloud.is_visible_in_tree() and local.is_visible_in_tree() and local.text == "返回本地", "cloud details use a compact back/title/refresh header without the brand and source rows")
	_check(screen.find_child("SaveScroll", true, false).get_v_scroll_bar().max_value <= 568 and screen.find_child("AutoBackup", true, false).get_global_rect().end.y <= 568, "320 cloud details and enabled backup fit without an outer scrolling layer")
	_check(first_cloud.get_global_rect().position.y >= region.get_global_rect().position.y and first_cloud.get_global_rect().end.y <= region.get_global_rect().end.y, "compact cloud details keep the first load button fully visible")
	service.state.error = "NETWORK_TIMEOUT"
	service.state_changed.emit(service.snapshot())
	_check(screen.find_child("CloudStatus", true, false).is_visible_in_tree() and not local.disabled and not screen.find_child("RefreshCloud", true, false).disabled, "cloud detail errors retain visible recovery and back navigation")
	local.pressed.emit()
	await process_frame
	await process_frame
	_check(service.choices.is_empty() and logo.is_visible_in_tree() and cloud.is_visible_in_tree() and local.text == "" and local.get_parent().name == "SaveSourceRows", "returning restores the brand and original source rows without reading a save")
	_check(not screen.find_child("AutoBackup", true, false).is_visible_in_tree() and screen.find_child("AutoBackup", true, false).button_pressed and screen.find_child("SaveScroll", true, false).get_v_scroll_bar().max_value <= 568, "local rows hide backup presentation while retaining the selected choice without outer scrolling")
	secondary = screen.find_child("StartNew", true, false)
	secondary.pressed.emit()
	_check(screen.find_child("ConfirmOverwrite", true, false).visible and local.focus_mode == Control.FOCUS_NONE, "row new journey keeps overwrite confirmation and source focus isolation")
	screen.find_child("CancelOverwrite", true, false).pressed.emit()
	cloud.pressed.emit()
	_check(screen.find_child("AutoBackup", true, false).is_visible_in_tree() and screen.find_child("AutoBackup", true, false).button_pressed, "reopening cloud details restores the selected backup control")
	local.pressed.emit()
	screen.find_child("ContinueLocal", true, false).pressed.emit()
	_check(service.choices.size() == 1 and service.choices[0].kind == "local" and service.choices[0].auto_backup, "local choice preserves backup consent set in cloud details even while its control is hidden")
	await _release(screen)
	root.size = Vector2i(390, 844)

func _test_backup_panel() -> void:
	var service := FakeService.new()
	service.tree = self
	service.state.loading = false
	service.state.busy = false
	service.state.upload_target = "selected"
	var panel := BackupPanel.new()
	panel.configure(service)
	root.add_child(panel)
	_check(service.initialize_calls == 0, "settings panel does not refresh or revoke session selection")
	panel.find_child("UploadLocal", true, false).pressed.emit()
	_check(service.upload_calls == 0 and panel.find_child("BackupConfirmation", true, false).visible, "manual backup requests explicit confirmation")
	_check("更新" in panel.find_child("ConfirmBackup", true, false).text, "selected cloud slot shows overwrite action")
	panel.find_child("CancelBackup", true, false).pressed.emit()
	_check(service.upload_calls == 0, "cancelled backup sends no upload")
	panel.find_child("UploadLocal", true, false).pressed.emit()
	panel.find_child("ConfirmBackup", true, false).pressed.emit()
	_check(panel.find_child("UploadLocal", true, false).disabled, "inflight backup prevents duplicate requests")
	await process_frame
	await process_frame
	_check(service.upload_calls == 1 and "已备份" in panel.find_child("BackupStatus", true, false).text, "successful backup is visible")
	service.state.backup_suspended = true
	service.state.upload_target = "new"
	service.state_changed.emit(service.snapshot())
	_check("重新打开" in panel.find_child("BackupDetail", true, false).text, "background suspension explains how to restore auto upload")
	panel.find_child("UploadLocal", true, false).pressed.emit()
	_check("新建" in panel.find_child("ConfirmBackup", true, false).text, "suspended session may explicitly create a new backup")
	service.state.upload_target = "selected"
	service.state_changed.emit(service.snapshot())
	_check(not panel.find_child("BackupConfirmation", true, false).visible and service.upload_calls == 1, "changed upload target invalidates old confirmation")
	service.state.remote_uncertain = true
	service.state_changed.emit(service.snapshot())
	_check(panel.find_child("UploadLocal", true, false).disabled and "核对" in panel.find_child("BackupStatus", true, false).text, "unknown remote outcome prevents blind retries")
	service.state.remote_uncertain = false
	service.state.status = "uploaded"
	service.state_changed.emit(service.snapshot())
	service.publish_upload_result = false
	service.upload_result = {"ok": false, "status": "rate_limited", "message": "上传过于频繁。", "retry_after_ms": 62000}
	panel.find_child("UploadLocal", true, false).pressed.emit()
	panel.find_child("ConfirmBackup", true, false).pressed.emit()
	await process_frame
	await process_frame
	_check("62" in panel.find_child("BackupStatus", true, false).text, "rate limit reports remaining minimum retry delay")
	_check("过于频繁" in panel.find_child("BackupStatus", true, false).text and not "已备份" in panel.find_child("BackupStatus", true, false).text, "early failure supersedes previous successful service snapshot")
	panel.queue_free()
	await process_frame

func _render() -> void:
	var output := "res://output/save-ui"
	var dimensions := Vector2i(390, 844)
	var variant := "normal"
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--output="):
			output = argument.trim_prefix("--output=")
		elif argument.begins_with("--width="):
			dimensions.x = int(argument.trim_prefix("--width="))
		elif argument.begins_with("--height="):
			dimensions.y = int(argument.trim_prefix("--height="))
		elif argument.begins_with("--variant="):
			variant = argument.trim_prefix("--variant=")
	root.size = dimensions
	var service := FakeService.new()
	var options := {}
	if FileAccess.file_exists("res://background.png"):
		options.background = load("res://background.png")
	if FileAccess.file_exists("res://font.ttf"):
		options.font = load("res://font.ttf")
	if variant == "empty":
		service.state.local = {"exists": false, "available": false}
		service.state.clouds = []
	elif variant == "error":
		service.state.error = "NETWORK_TIMEOUT"
		service.state.clouds = []
	elif variant == "english":
		options.locale = "en"
		options.title = "The Long Journey"
		service.state.local = {"exists": true, "available": true, "label": "Local progress", "summary": "Chapter 2 · Safe house", "updated_at": "2026-10-08 09:24"}
		service.state.clouds = [{"id": "cloud-1", "label": "Cloud progress", "summary": "Chapter 1 · Arrival", "updated_at": "2026-10-07 22:18"}]
	var screen := _make(service, options)
	await create_timer(0.3).timeout
	await RenderingServer.frame_post_draw
	DirAccess.make_dir_recursive_absolute(output)
	root.get_texture().get_image().save_png(output.path_join("save-start-%dx%d-%s.png" % [dimensions.x, dimensions.y, variant]))
	if variant == "normal" or variant == "english":
		var scroll := screen.find_child("SaveScroll", true, false) as ScrollContainer
		scroll.scroll_vertical = int(scroll.get_v_scroll_bar().max_value)
		await create_timer(0.15).timeout
		await RenderingServer.frame_post_draw
		root.get_texture().get_image().save_png(output.path_join("save-bottom-%dx%d-%s.png" % [dimensions.x, dimensions.y, variant]))
		_check(screen.find_child("AutoBackup", true, false).get_global_rect().end.x <= dimensions.x, "backup checkbox fits narrow viewport")
		screen.find_child("UseCloud_cloud-1", true, false).pressed.emit()
		await create_timer(0.15).timeout
		await RenderingServer.frame_post_draw
		root.get_texture().get_image().save_png(output.path_join("save-confirm-%dx%d-%s.png" % [dimensions.x, dimensions.y, variant]))
	print("SAVE_SCREEN_RENDER: %dx%d %s %s" % [dimensions.x, dimensions.y, variant, output])
	await _release(screen)
