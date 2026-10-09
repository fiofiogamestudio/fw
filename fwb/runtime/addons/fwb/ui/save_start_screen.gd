extends Control
## Reusable startup save picker. Save bytes and game state belong to the service/host.
## configure(service, {background: Texture2D, title, subtitle, theme: Theme, font: Font,
## locale: "zh-CN"|"en", strings: Dictionary, safe_insets: Vector4, palette: Dictionary,
## cornerRadius: int, primaryButtonVariation: String, buttonVariation: String,
## layout: "cards"|"cover", fontSizes: Dictionary, showTimestamps: bool}) before add_child.
signal completed(result: Dictionary)

const INK := Color("e8eff0")
const MUTED := Color("9baeb2")
const ACCENT := Color("91d4c4")
const SURFACE := Color(0.035, 0.065, 0.077, 0.92)
const BORDER := Color(0.5, 0.72, 0.72, 0.23)

var _service: Object
var _options: Dictionary = {}
var _state: Dictionary = {}
var _strings: Dictionary = {}
var _palette: Dictionary = {}
var _font_sizes: Dictionary = {}
var _source := "local"
var _finished := false
var _operation_busy := false
var _operation_error := ""
var _pending: Callable
var _restore_focus: Control
var _safe: MarginContainer
var _scroll: ScrollContainer
var _content: MarginContainer
var _column: VBoxContainer
var _heading: VBoxContainer
var _cover_spacer: Control
var _title: Label
var _local_page: Control
var _cloud_page: Control
var _cloud_scroll: ScrollContainer
var _cloud_heading: HBoxContainer
var _source_tabs: HBoxContainer
var _source_rows: VBoxContainer
var _row_summaries: Dictionary = {}
var _row_markers: Dictionary = {}
var _local_tab: Button
var _cloud_tab: Button
var _selection_status: Label
var _local_card: VBoxContainer
var _cloud_list: VBoxContainer
var _status: Label
var _refresh: Button
var _backup: CheckBox
var _backup_box: VBoxContainer
var _backup_note: Label
var _confirm_layer: Control
var _confirm_panel: PanelContainer
var _confirm_title: Label
var _confirm_message: Label
var _confirm_cancel: Button
var _confirm_action: Button

func configure(service: Object, options: Dictionary = {}) -> void:
	_service = service
	_options = options.duplicate()
	var palette: Variant = options.get("palette", {})
	_palette = palette.duplicate() if palette is Dictionary else {}
	var font_sizes: Variant = options.get("fontSizes", {})
	_font_sizes = font_sizes.duplicate() if font_sizes is Dictionary else {}
	_strings = _english() if str(options.get("locale", "zh-CN")) == "en" else _chinese()
	var overrides: Variant = options.get("strings", {})
	if overrides is Dictionary:
		_strings.merge(overrides, true)
	if options.get("theme") is Theme:
		theme = options.theme
	if options.get("font") is Font:
		theme = theme.duplicate() if theme != null else Theme.new()
		theme.default_font = options.font
	process_mode = Node.PROCESS_MODE_ALWAYS

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	if _strings.is_empty():
		_strings = _chinese()
	_build()
	resized.connect(_layout)
	_layout()
	if not is_instance_valid(_service):
		_status.text = _text("missing_service")
		_selection_status.text = _text("missing_service")
		_selection_status.visible = _is_cover()
		return
	_service.state_changed.connect(_on_state_changed)
	_on_state_changed(_service.snapshot())
	_initialize.call_deferred()

func _exit_tree() -> void:
	if is_instance_valid(_service) and _service.state_changed.is_connected(_on_state_changed):
		_service.state_changed.disconnect(_on_state_changed)

func _initialize() -> void:
	await _service.initialize()
	if is_inside_tree() and not _finished:
		_on_state_changed(_service.snapshot())

func _build() -> void:
	var base := ColorRect.new()
	base.color = _color("background", Color("091519"))
	_full(base, self)
	if _options.get("background") is Texture2D:
		var image := TextureRect.new()
		image.texture = _options.background
		image.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		image.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
		_full(image, self)
	var gradient := Gradient.new()
	gradient.set_color(0, _color("overlay_top", Color(0.018, 0.04, 0.05, 0.18)))
	gradient.set_color(1, _color("overlay_bottom", Color(0.018, 0.04, 0.05, 0.98)))
	gradient.add_point(0.4, _color("overlay_middle", Color(0.018, 0.04, 0.05, 0.77)))
	var gradient_texture := GradientTexture2D.new()
	gradient_texture.gradient = gradient
	gradient_texture.fill_from = Vector2(0.5, 0)
	gradient_texture.fill_to = Vector2(0.5, 1)
	var shade := TextureRect.new()
	shade.texture = gradient_texture
	shade.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_full(shade, self)
	_safe = MarginContainer.new()
	_full(_safe, self, false)
	_scroll = ScrollContainer.new()
	_scroll.name = "SaveScroll"
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.follow_focus = true
	_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_safe.add_child(_scroll)
	_content = MarginContainer.new()
	_content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	if _is_cover():
		_content.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_scroll.add_child(_content)
	_column = VBoxContainer.new()
	_column.add_theme_constant_override("separation", 16)
	_content.add_child(_column)
	var heading := VBoxContainer.new()
	_heading = heading
	heading.name = "SaveHeading"
	heading.add_theme_constant_override("separation", 12)
	_column.add_child(heading)
	var has_brand := _options.get("brandTexture") is Texture2D
	if has_brand:
		var brand := TextureRect.new()
		brand.name = "SaveBrand"
		brand.texture = _options.brandTexture
		if _options.get("brandMaterial") is Material:
			brand.material = _options.brandMaterial
		brand.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		brand.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		brand.custom_minimum_size = Vector2(maxf(1, float(_options.get("brandWidth", 144))), maxf(1, float(_options.get("brandHeight", 124))))
		brand.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
		brand.mouse_filter = Control.MOUSE_FILTER_IGNORE
		heading.add_child(brand)
	var eyebrow := _label(str(_options.get("eyebrow", _text("eyebrow"))), _font_size("eyebrow", 12), _color("accent", ACCENT))
	eyebrow.visible = not has_brand and not eyebrow.text.is_empty()
	heading.add_child(eyebrow)
	_title = _label(str(_options.get("title", ProjectSettings.get_setting("application/config/name", "Game"))), _font_size("title", 32), _color("ink", INK))
	_title.name = "SaveTitle"
	_title.visible = not has_brand
	_title.add_theme_constant_override("line_spacing", 2)
	heading.add_child(_title)
	var subtitle := _label(str(_options.get("subtitle", _text("subtitle"))), _font_size("subtitle", 14), _color("muted", MUTED))
	subtitle.name = "SaveSubtitle"
	subtitle.visible = not has_brand and not subtitle.text.is_empty()
	heading.add_child(subtitle)
	var actions := _column
	if _is_cover():
		var spacer := Control.new()
		_cover_spacer = spacer
		spacer.name = "CoverSpacer"
		spacer.custom_minimum_size.y = 0 if _is_rows() else 96
		spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
		spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_column.add_child(spacer)
		actions = VBoxContainer.new()
		actions.name = "SaveActions"
		actions.add_theme_constant_override("separation", 16 if _is_rows() else 12)
		_column.add_child(actions)
		_build_source_tabs(actions)
		_local_page = VBoxContainer.new()
		(_local_page as VBoxContainer).alignment = BoxContainer.ALIGNMENT_END
	else:
		_local_page = _panel()
	_local_page.name = "LocalSaves"
	actions.add_child(_local_page)
	_local_card = VBoxContainer.new()
	_local_card.add_theme_constant_override("separation", 8 if _is_cover() else 9)
	_local_page.add_child(_local_card)
	if _is_cover() and not _is_rows():
		_local_card.minimum_size_changed.connect(_sync_cover_page_height)
	var cloud_section := VBoxContainer.new()
	if _is_cover():
		_cloud_page = VBoxContainer.new()
		if _is_rows():
			_cloud_page.add_theme_constant_override("separation", 8)
		_cloud_scroll = ScrollContainer.new()
		_cloud_scroll.name = "CloudSaveScroll"
		_cloud_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
		_cloud_scroll.follow_focus = true
		_cloud_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		if _is_rows():
			_cloud_scroll.custom_minimum_size.y = maxf(144, float(_options.get("coverPageMinHeight", 176)))
		_cloud_page.add_child(_cloud_scroll)
		_cloud_scroll.add_child(cloud_section)
		cloud_section.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	else:
		_cloud_page = cloud_section
	_cloud_page.name = "CloudSaves"
	cloud_section.add_theme_constant_override("separation", 8 if _is_cover() else 10)
	actions.add_child(_cloud_page)
	_refresh = _button(_text("refresh"), false)
	_refresh.name = "RefreshCloud"
	_refresh.custom_minimum_size = Vector2(64 if _is_cover() else 78, 48)
	_refresh.pressed.connect(_refresh_cloud)
	if _is_cover() and not _is_rows():
		_source_tabs.add_child(_refresh)
	else:
		var cloud_heading := HBoxContainer.new()
		_cloud_heading = cloud_heading
		cloud_heading.add_theme_constant_override("separation", 12)
		if _is_rows():
			_cloud_page.add_child(cloud_heading)
			_cloud_page.move_child(cloud_heading, 0)
		else:
			cloud_section.add_child(cloud_heading)
		var cloud_label := _label("" if _is_rows() else _text("cloud_section"), _font_size("section", 16), _color("ink", INK))
		cloud_label.name = "CloudSectionTitle"
		cloud_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cloud_heading.add_child(cloud_label)
		cloud_heading.add_child(_refresh)
	_status = _label("", _font_size("body", 13), _color("muted", MUTED))
	_status.name = "CloudStatus"
	cloud_section.add_child(_status)
	_cloud_list = VBoxContainer.new()
	_cloud_list.add_theme_constant_override("separation", 8 if _is_cover() else 10)
	cloud_section.add_child(_cloud_list)
	var backup_box := VBoxContainer.new()
	_backup_box = backup_box
	backup_box.add_theme_constant_override("separation", 8 if _is_cover() else 5)
	actions.add_child(backup_box)
	_selection_status = _label("", _font_size("body", 13), _color("warning", Color("e2bf8b")))
	_selection_status.name = "SelectionStatus"
	_selection_status.hide()
	actions.add_child(_selection_status)
	_backup = CheckBox.new()
	_backup.name = "AutoBackup"
	_backup.text = _text("auto_backup")
	_backup.custom_minimum_size.y = 48
	_backup.add_theme_color_override("font_color", _color("ink", INK))
	_backup.add_theme_font_size_override("font_size", _font_size("button", 14))
	_backup.toggled.connect(_on_backup_toggled)
	backup_box.add_child(_backup)
	_backup_note = _label(_text("backup_note"), _font_size("meta", 12), _color("muted", MUTED))
	backup_box.add_child(_backup_note)
	var footer := _label(_text("footer"), _font_size("meta", 12), _color("footer", Color("71878c")))
	footer.name = "SaveFooter"
	footer.visible = bool(_options.get("showFooter", not _is_cover())) and not footer.text.is_empty()
	actions.add_child(footer)
	_update_source_visibility()
	_build_confirmation()

func _build_source_tabs(parent: Node) -> void:
	if _is_rows():
		_build_source_rows(parent)
		return
	var tabs := HBoxContainer.new()
	_source_tabs = tabs
	tabs.name = "SaveSourceTabs"
	tabs.add_theme_constant_override("separation", 8)
	parent.add_child(tabs)
	var group := ButtonGroup.new()
	_local_tab = _button(_text("local_tab"), false)
	_cloud_tab = _button(_text("cloud_section"), false)
	_local_tab.name = "LocalSourceTab"
	_cloud_tab.name = "CloudSourceTab"
	for tab in [_local_tab, _cloud_tab]:
		if _options.has("sourceTabVariation"):
			tab.theme_type_variation = str(_options.sourceTabVariation)
		tab.toggle_mode = true
		tab.button_group = group
		tab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		tabs.add_child(tab)
	_local_tab.set_pressed_no_signal(true)
	_local_tab.pressed.connect(_select_source.bind("local"))
	_cloud_tab.pressed.connect(_select_source.bind("cloud"))

func _build_source_rows(parent: Node) -> void:
	var section := VBoxContainer.new()
	_source_rows = section
	section.name = "SaveSourceRows"
	section.add_theme_constant_override("separation", 8)
	parent.add_child(section)
	var source_heading := _label(_text("source_heading"), _font_size("section", 16), _color("ink", INK))
	source_heading.name = "SaveSourceHeading"
	section.add_child(source_heading)
	_local_tab = _source_row("local", _text("local_tab"))
	_cloud_tab = _source_row("cloud", _text("cloud_section"))
	_local_tab.name = "LocalSourceTab"
	_cloud_tab.name = "CloudSourceTab"
	var group := ButtonGroup.new()
	for row in [_local_tab, _cloud_tab]:
		row.toggle_mode = true
		row.button_group = group
		section.add_child(row)
	_local_tab.set_pressed_no_signal(true)
	_local_tab.pressed.connect(_select_source.bind("local"))
	_cloud_tab.pressed.connect(_select_source.bind("cloud"))

func _source_row(source: String, caption: String) -> Button:
	var row := _button("", false)
	row.theme_type_variation = str(_options.get("sourceRowVariation", _options.get("buttonVariation", "")))
	var padding := MarginContainer.new()
	padding.name = "SourceRowContent"
	_full(padding, row)
	padding.add_theme_constant_override("margin_left", 12)
	padding.add_theme_constant_override("margin_right", 12)
	var content := HBoxContainer.new()
	content.add_theme_constant_override("separation", 8)
	content.mouse_filter = Control.MOUSE_FILTER_IGNORE
	padding.add_child(content)
	var marker := Panel.new()
	marker.name = "SourceMarker"
	marker.custom_minimum_size = Vector2(10, 10)
	marker.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	marker.mouse_filter = Control.MOUSE_FILTER_IGNORE
	content.add_child(marker)
	_row_markers[source] = marker
	var label := _label(caption, _font_size("sourceRowText", _font_size("button", 14)), _color("ink", INK))
	label.name = "SourceName"
	label.autowrap_mode = TextServer.AUTOWRAP_OFF
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	content.add_child(label)
	var summary := _label("", _font_size("sourceRowText", _font_size("button", 14)), _color("muted", MUTED))
	summary.name = "SourceSummary"
	summary.autowrap_mode = TextServer.AUTOWRAP_OFF
	summary.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	summary.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	summary.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	summary.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	content.add_child(summary)
	_row_summaries[source] = summary
	return row

func _select_source(source: String) -> void:
	if _operation_busy or _finished or _confirm_layer.visible:
		return
	_source = source
	_update_source_visibility()
	if _is_rows():
		_restore_named_focus.call_deferred("LocalSourceTab")

func _update_source_visibility() -> void:
	if not _is_cover():
		return
	_local_page.visible = _source == "local"
	_cloud_page.visible = _source == "cloud"
	_local_tab.set_pressed_no_signal(_source == "local")
	_cloud_tab.set_pressed_no_signal(_source == "cloud")
	_update_rows_detail_layout()
	_update_source_rows()
	_update_backup_visibility()

func _update_rows_detail_layout() -> void:
	if not _is_rows():
		return
	var cloud_detail := _source == "cloud"
	_heading.visible = not cloud_detail
	_cover_spacer.visible = not cloud_detail
	_source_rows.visible = not cloud_detail
	var target: Node = _cloud_heading if cloud_detail else _source_rows
	if _local_tab.get_parent() != target:
		_local_tab.reparent(target)
		target.move_child(_local_tab, 0 if cloud_detail else 1)
	_local_tab.text = _text("back_local") if cloud_detail else ""
	_local_tab.find_child("SourceRowContent", true, false).visible = not cloud_detail
	_local_tab.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN if cloud_detail else Control.SIZE_FILL
	_local_tab.theme_type_variation = str(_options.get("buttonVariation", "")) if cloud_detail else str(_options.get("sourceRowVariation", _options.get("buttonVariation", "")))
	_cloud_heading.find_child("CloudSectionTitle", true, false).text = _text("cloud_section") if cloud_detail else ""
	_cloud_heading.visible = cloud_detail or bool(_state.get("cloud_available", false))
	if _confirm_panel != null:
		_layout()

func _update_source_rows() -> void:
	if not _is_rows():
		return
	var local: Dictionary = _state.get("local", {})
	var local_summary := _text("row_new")
	if bool(local.get("exists", false)):
		local_summary = _text("row_ready") if bool(local.get("available", local.get("valid", false))) else _text("row_invalid")
	var formatter: Variant = _options.get("localRowSummary")
	if formatter is Callable and formatter.is_valid():
		local_summary = str(formatter.call(local.duplicate(true)))
	_row_summaries.local.text = local_summary.replace("\n", " ").strip_edges()
	var clouds: Array = _state.get("clouds", _state.get("archives", []))
	var cloud_summary := _text("row_count") % clouds.size() if not clouds.is_empty() else _text("row_empty")
	if bool(_state.get("loading", false)):
		cloud_summary = _text("row_loading")
	elif _operation_busy or bool(_state.get("busy", false)):
		cloud_summary = _text("row_working")
	elif not str(_state.get("error", "")).is_empty():
		cloud_summary = _text("row_error")
	elif not bool(_state.get("cloud_available", false)):
		cloud_summary = _text("row_offline")
	_row_summaries.cloud.text = cloud_summary
	for source: String in ["local", "cloud"]:
		var selected := _source == source
		var marker_style := StyleBoxFlat.new()
		marker_style.bg_color = _color("accent", ACCENT) if selected else Color.TRANSPARENT
		marker_style.border_color = _color("accent", ACCENT) if selected else _color("border", BORDER)
		marker_style.set_border_width_all(1)
		_row_markers[source].add_theme_stylebox_override("panel", marker_style)
		var row: Button = _local_tab if source == "local" else _cloud_tab
		var color := _color("ink", INK) if selected else _color("muted", MUTED)
		row.find_child("SourceName", true, false).add_theme_color_override("font_color", color)
		_row_summaries[source].add_theme_color_override("font_color", color)
		row.tooltip_text = (_text("local_tab") if source == "local" else _text("cloud_section")) + " · " + _row_summaries[source].text

func _sync_cover_page_height() -> void:
	if _is_rows() or _cloud_scroll == null or _local_card == null or not _local_page.visible:
		return
	# Hidden containers do not lay out freshly rebuilt labels. Measure them at the
	# available page width so wrapped text cannot reserve one line per character.
	var page_width := maxf(1, _content.size.x - _content.get_theme_constant("margin_left") - _content.get_theme_constant("margin_right"))
	_local_card.size.x = page_width
	for child in _local_card.get_children():
		if child is Control:
			child.size.x = page_width
	var page_height := maxf(maxf(144, float(_options.get("coverPageMinHeight", 144))), _local_card.get_combined_minimum_size().y)
	_local_page.custom_minimum_size.y = page_height
	_cloud_scroll.custom_minimum_size.y = page_height

func _layout() -> void:
	if _safe == null:
		return
	var insets: Vector4 = _options.get("safe_insets", Vector4.ZERO)
	if not _options.has("safe_insets") and OS.has_feature("mobile") and not OS.has_feature("web"):
		var display := Vector2(DisplayServer.screen_get_size())
		var safe_area := DisplayServer.get_display_safe_area()
		if display.x > 0 and display.y > 0:
			var scale_factor := size / display
			insets = Vector4(safe_area.position.x * scale_factor.x, safe_area.position.y * scale_factor.y,
				(display.x - safe_area.end.x) * scale_factor.x, (display.y - safe_area.end.y) * scale_factor.y)
	_safe.add_theme_constant_override("margin_left", int(maxf(0, insets.x)))
	_safe.add_theme_constant_override("margin_top", int(maxf(0, insets.y)))
	_safe.add_theme_constant_override("margin_right", int(maxf(0, insets.z)))
	_safe.add_theme_constant_override("margin_bottom", int(maxf(0, insets.w)))
	var usable_width := maxf(0, size.x - insets.x - insets.z)
	var side := int(maxf(20 if _is_rows() else (16 if _is_cover() else 22), (usable_width - 480) * 0.5))
	_content.add_theme_constant_override("margin_left", side)
	_content.add_theme_constant_override("margin_right", side)
	_content.add_theme_constant_override("margin_top", (32 if size.y >= 720 else 24) if _is_cover() else (48 if size.y >= 720 else 28))
	if _is_cover() and _options.has("coverTopInsetRatio"):
		_content.add_theme_constant_override("margin_top", int(maxf(0, size.y - insets.y - insets.w) * clampf(float(_options.coverTopInsetRatio), 0, 0.35)))
	if _is_rows() and _source == "cloud":
		_content.add_theme_constant_override("margin_top", 24)
	_content.add_theme_constant_override("margin_bottom", 24 if _is_rows() else (16 if _is_cover() else 28))
	if _is_cover():
		_content.custom_minimum_size.y = maxf(0, size.y - insets.y - insets.w)
	_title.add_theme_font_size_override("font_size", _font_size("title", 32 if usable_width >= 360 else 27))
	_confirm_panel.custom_minimum_size.x = minf(420, maxf(220, usable_width - 40))
	_confirm_panel.size_flags_horizontal = Control.SIZE_SHRINK_CENTER

func _on_state_changed(state: Dictionary) -> void:
	if _finished or _local_card == null:
		return
	_state = state.duplicate(true)
	var previous_focus := get_viewport().gui_get_focus_owner()
	var focus_name := str(previous_focus.name) if previous_focus != null else ""
	_clear(_local_card)
	_clear(_cloud_list)
	var local: Dictionary = state.get("local", {})
	var has_local := bool(local.get("exists", false))
	var can_continue := bool(local.get("available", local.get("valid", false)))
	if not _is_cover():
		_local_card.add_child(_label(_text("local_section"), _font_size("eyebrow", 12), _color("accent", ACCENT)))
	var local_title := _label(str(_options.get("localTitle", _text("local_title"))) if has_local else _text("new_title"), _font_size("saveTitle", 20), _color("ink", INK))
	local_title.name = "LocalSaveTitle"
	local_title.visible = bool(_options.get("showLocalTitle", not _is_cover()))
	_local_card.add_child(local_title)
	var details := _details(local)
	if not has_local:
		details = _text("new_summary") if bool(_options.get("showNewSummary", not _is_cover())) else ""
	elif not can_continue:
		details = _text("invalid_local")
	if not details.is_empty() and (bool(_options.get("showLocalDetails", true)) or (has_local and not can_continue)):
		var local_details := _label(details, _font_size("body", 13), _color("muted", MUTED))
		local_details.name = "LocalSaveDetails"
		_local_card.add_child(local_details)
	var local_action := _button(_text("continue_local") if can_continue else _text("start_new"), true)
	local_action.name = "ContinueLocal" if can_continue else "StartNew"
	local_action.pressed.connect(_choose_local if can_continue else _request_new)
	_local_card.add_child(local_action)
	if can_continue:
		var new_action := _button(_text("start_new"), false)
		if _options.has("secondaryButtonVariation"):
			new_action.theme_type_variation = str(_options.secondaryButtonVariation)
		if bool(_options.get("secondaryActionCentered", false)):
			new_action.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
		new_action.name = "StartNew"
		new_action.pressed.connect(_request_new)
		_local_card.add_child(new_action)
	var cloud_available := bool(state.get("cloud_available", false))
	var loading := bool(state.get("loading", false))
	var write_busy := bool(state.get("busy", false)) and not loading
	var clouds: Array = state.get("clouds", state.get("archives", []))
	_refresh.disabled = loading or bool(state.get("busy", false)) or _operation_busy
	_refresh.visible = cloud_available
	if _is_rows():
		_cloud_heading.visible = cloud_available or _source == "cloud"
	_status.text = _status_message(state, clouds)
	_status.visible = not _is_cover() or clouds.is_empty() or loading or write_busy or _operation_busy or not cloud_available or not str(state.get("error", "")).is_empty() or not _operation_error.is_empty()
	_selection_status.text = _operation_error
	_selection_status.visible = _is_cover() and not _operation_error.is_empty()
	_status.add_theme_color_override("font_color", _color("warning", Color("e2bf8b")) if not str(state.get("error", "")).is_empty() or not _operation_error.is_empty() else _color("muted", MUTED))
	for item: Dictionary in clouds:
		var cloud_panel := _panel()
		_cloud_list.add_child(cloud_panel)
		var cloud_card := VBoxContainer.new()
		cloud_card.add_theme_constant_override("separation", 8 if _is_cover() else 9)
		cloud_panel.add_child(cloud_card)
		var cloud_title := str(item.get("label", _text("cloud_title"))).strip_edges()
		if cloud_title.is_empty() or cloud_title == str(item.get("summary", "")).strip_edges():
			cloud_title = str(_options.get("cloudTitle", _text("cloud_title")))
		cloud_card.add_child(_label(cloud_title, _font_size("saveTitle", 18), _color("ink", INK)))
		var cloud_details := _details(item)
		if not cloud_details.is_empty():
			cloud_card.add_child(_label(cloud_details, _font_size("body", 13), _color("muted", MUTED)))
		var choose := _button(_text("use_cloud"), false)
		choose.name = "UseCloud_%s" % str(item.get("id", "")).validate_node_name()
		choose.pressed.connect(_request_cloud.bind(str(item.get("id", "")), cloud_title))
		cloud_card.add_child(choose)
	_backup.disabled = _operation_busy or write_busy
	_update_backup_visibility()
	_set_actions_disabled(_local_card, _operation_busy or write_busy)
	_set_actions_disabled(_cloud_list, _operation_busy or write_busy or loading)
	if _is_cover():
		_sync_cover_page_height()
		_local_tab.disabled = _operation_busy or write_busy
		_cloud_tab.disabled = _operation_busy or write_busy
		_update_source_rows()
	if _confirm_layer.visible:
		_set_focus_enabled(_scroll, false)
	if not focus_name.is_empty() and not _confirm_layer.visible:
		_restore_named_focus.call_deferred(focus_name)

func _restore_named_focus(focus_name: String) -> void:
	# Snapshot changes can rebuild the same row more than once before the deferred
	# call executes. Resolve the live node now instead of retaining an obsolete row.
	if not is_inside_tree() or _finished or _confirm_layer.visible:
		return
	var replacement := find_child(focus_name, true, false)
	if not replacement is Control or not replacement.is_inside_tree() or not replacement.is_visible_in_tree():
		return
	if replacement.focus_mode == Control.FOCUS_NONE or (replacement is BaseButton and replacement.disabled):
		return
	replacement.grab_focus()

func _status_message(state: Dictionary, clouds: Array) -> String:
	if not _operation_error.is_empty():
		return _operation_error
	if bool(state.get("loading", false)):
		return _text("loading")
	if _operation_busy or bool(state.get("busy", false)):
		return _text("working")
	if not str(state.get("error", "")).is_empty():
		return _text("cloud_error")
	if not bool(state.get("cloud_available", false)):
		return _text("offline")
	return _text("cloud_empty") if clouds.is_empty() else _text("cloud_ready")

func _details(record: Dictionary) -> String:
	var summary := str(record.get("summary", "")).strip_edges()
	if not bool(_options.get("showTimestamps", true)):
		return summary
	var updated: Variant = record.get("updated_at", "")
	var stamp := ""
	if updated is String:
		stamp = str(updated).replace("T", " ").trim_suffix("Z")
	elif (updated is int or updated is float) and float(updated) > 0:
		var seconds := int(updated)
		if seconds > 9999999999:
			seconds = int(seconds / 1000)
		stamp = Time.get_datetime_string_from_unix_time(seconds).replace("T", " ") + " UTC"
	if not stamp.is_empty():
		summary += ("\n" if not summary.is_empty() else "") + _text("updated") + stamp
	return summary

func _refresh_cloud() -> void:
	if _operation_busy or _finished:
		return
	_operation_error = ""
	await _service.refresh()
	if is_inside_tree() and not _finished:
		_on_state_changed(_service.snapshot())

func _choose_local() -> void:
	await _run_choice("choose_local", [])

func _request_new() -> void:
	if bool(_state.get("local", {}).get("exists", false)):
		_confirm(_text("new_confirm_title"), _text("new_confirm_body"), _text("start_new"), _choose_new.bind(true))
	else:
		_choose_new(false)

func _choose_new(confirmed: bool) -> void:
	await _run_choice("choose_new", [confirmed])

func _request_cloud(id: String, label: String) -> void:
	if bool(_state.get("local", {}).get("exists", false)):
		var short_label := label if label.length() <= 48 else label.substr(0, 47) + "…"
		_confirm(_text("cloud_confirm_title"), _text("cloud_confirm_body") % short_label, _text("use_cloud"), _choose_cloud.bind(id))
	else:
		_choose_cloud(id)

func _choose_cloud(id: String) -> void:
	await _run_choice("choose_cloud", [id])

func _run_choice(method: String, arguments: Array) -> void:
	if _operation_busy or _finished:
		return
	_operation_busy = true
	_operation_error = ""
	_on_state_changed(_state)
	var backup_selected := _backup.visible and _backup.button_pressed
	if _is_rows():
		backup_selected = _backup_supported() and _backup.button_pressed
	arguments.append(backup_selected)
	var result: Dictionary = await _service.callv(method, arguments)
	if not is_inside_tree():
		return
	_operation_busy = false
	if bool(result.get("ok", false)):
		_finished = true
		_set_actions_disabled(_local_card, true)
		_set_actions_disabled(_cloud_list, true)
		completed.emit(result)
	else:
		_operation_error = _text("selection_error")
		_on_state_changed(_service.snapshot())

func _on_backup_toggled(value: bool) -> void:
	_backup_note.visible = _backup.visible and value

func _backup_supported() -> bool:
	return bool(_state.get("cloud_available", false)) and bool(_state.get("auto_backup_supported", true))

func _update_backup_visibility() -> void:
	_backup.visible = _backup_supported() and (not _is_rows() or _source == "cloud")
	_backup_note.visible = _backup.visible and _backup.button_pressed
	if _is_rows():
		_backup_box.visible = _backup.visible

func _build_confirmation() -> void:
	_confirm_layer = Control.new()
	_confirm_layer.name = "ConfirmOverwrite"
	_full(_confirm_layer, self, false)
	_confirm_layer.mouse_filter = Control.MOUSE_FILTER_STOP
	var dim := ColorRect.new()
	dim.color = _color("modal_overlay", Color(0.015, 0.025, 0.03, 0.87))
	_full(dim, _confirm_layer)
	var center := CenterContainer.new()
	_full(center, _confirm_layer, false)
	_confirm_panel = _panel()
	center.add_child(_confirm_panel)
	var body := VBoxContainer.new()
	body.add_theme_constant_override("separation", 16)
	_confirm_panel.add_child(body)
	_confirm_title = _label("", _font_size("confirmationTitle", 22), _color("ink", INK))
	_confirm_title.name = "ConfirmationTitle"
	body.add_child(_confirm_title)
	_confirm_message = _label("", _font_size("confirmationBody", 14), _color("muted", MUTED))
	_confirm_message.name = "ConfirmationBody"
	body.add_child(_confirm_message)
	var actions := VBoxContainer.new()
	actions.add_theme_constant_override("separation", 8 if _is_cover() else 10)
	body.add_child(actions)
	_confirm_cancel = _button(_text("cancel"), false)
	_confirm_cancel.name = "CancelOverwrite"
	_confirm_cancel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_confirm_cancel.pressed.connect(_cancel_confirmation)
	actions.add_child(_confirm_cancel)
	_confirm_action = _button("", true)
	_confirm_action.name = "AcceptOverwrite"
	_confirm_action.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_confirm_action.pressed.connect(_accept_confirmation)
	actions.add_child(_confirm_action)
	_confirm_layer.hide()

func _confirm(title_text: String, message: String, action: String, callback: Callable) -> void:
	if _operation_busy or _finished:
		return
	_restore_focus = get_viewport().gui_get_focus_owner()
	_pending = callback
	_confirm_title.text = title_text
	_confirm_message.text = message
	_confirm_action.text = action
	_confirm_layer.show()
	_confirm_cancel.grab_focus()
	# The background controls must not remain keyboard-reachable while modal.
	_scroll.process_mode = Node.PROCESS_MODE_DISABLED
	_set_focus_enabled(_scroll, false)

func _cancel_confirmation() -> void:
	_confirm_layer.hide()
	_pending = Callable()
	_scroll.process_mode = Node.PROCESS_MODE_INHERIT
	_set_focus_enabled(_scroll, true)
	if is_instance_valid(_restore_focus):
		_restore_focus.grab_focus()

func _accept_confirmation() -> void:
	var callback := _pending
	_cancel_confirmation()
	if callback.is_valid():
		callback.call()

func _unhandled_key_input(event: InputEvent) -> void:
	if _confirm_layer != null and _confirm_layer.visible and event.is_action_pressed("ui_cancel"):
		_cancel_confirmation()
		get_viewport().set_input_as_handled()

func _set_focus_enabled(node: Node, enabled: bool) -> void:
	if node is BaseButton:
		node.focus_mode = Control.FOCUS_ALL if enabled else Control.FOCUS_NONE
	for child in node.get_children():
		_set_focus_enabled(child, enabled)

func _set_actions_disabled(node: Node, disabled: bool) -> void:
	if node is BaseButton:
		node.disabled = disabled
	for child in node.get_children():
		_set_actions_disabled(child, disabled)

func _clear(node: Node) -> void:
	for child in node.get_children():
		node.remove_child(child)
		child.queue_free()

func _full(node: Control, parent: Node, ignore_input: bool = true) -> void:
	parent.add_child(node)
	node.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	if ignore_input:
		node.mouse_filter = Control.MOUSE_FILTER_IGNORE

func _label(value: String, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.text = value
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label

func _style(color: Color, border: Color, width: int = 1) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.border_color = border
	style.set_border_width_all(width)
	style.set_corner_radius_all(maxi(0, int(_options.get("cornerRadius", 12))))
	style.content_margin_left = 18
	style.content_margin_right = 18
	style.content_margin_top = 16
	style.content_margin_bottom = 16
	if _options.has("panelPadding") or _is_cover():
		var padding := maxi(0, int(_options.get("panelPadding", 16)))
		style.content_margin_left = padding
		style.content_margin_right = padding
		style.content_margin_top = padding
		style.content_margin_bottom = padding
	return style

func _panel() -> PanelContainer:
	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override("panel", _style(_color("surface", SURFACE), _color("border", BORDER)))
	return panel

func _button(value: String, primary: bool) -> Button:
	var button := Button.new()
	button.text = value
	button.custom_minimum_size.y = 48
	var button_font_size := _font_size("primaryButton", _font_size("button", 14)) if primary else _font_size("button", 14)
	if _font_sizes.has("button") or (primary and _font_sizes.has("primaryButton")):
		button.add_theme_font_size_override("font_size", button_font_size)
	# An explicitly supplied game theme owns every button state. Do not mutate its
	# shared StyleBoxes or cover its font/color settings with the default skin.
	if _options.get("theme") is Theme:
		button.theme_type_variation = str(_options.get("primaryButtonVariation", "FwbSavePrimaryButton") if primary else _options.get("buttonVariation", ""))
		return button
	button.add_theme_font_size_override("font_size", button_font_size)
	button.add_theme_color_override("font_color", Color("112a2a") if primary else _color("ink", INK))
	button.add_theme_color_override("font_hover_color", Color("112a2a") if primary else Color.WHITE)
	button.add_theme_color_override("font_pressed_color", Color("112a2a") if primary else Color.WHITE)
	button.add_theme_stylebox_override("normal", _style(_color("accent", ACCENT) if primary else Color(0.25, 0.4, 0.42, 0.13), Color.TRANSPARENT if primary else _color("border", BORDER)))
	button.add_theme_stylebox_override("hover", _style(Color("b5e8dc") if primary else Color(0.3, 0.5, 0.52, 0.28), _color("accent", ACCENT)))
	button.add_theme_stylebox_override("pressed", _style(Color("71bbaa") if primary else Color(0.3, 0.5, 0.52, 0.38), _color("accent", ACCENT)))
	button.add_theme_stylebox_override("disabled", _style(Color(0.3, 0.4, 0.41, 0.25), _color("border", BORDER)))
	for style_name in ["normal", "hover", "pressed", "disabled"]:
		var button_style := button.get_theme_stylebox(style_name) as StyleBoxFlat
		button_style.content_margin_top = 10
		button_style.content_margin_bottom = 10
	var focus := _style(Color.TRANSPARENT, Color("e4fff8"), 2)
	button.add_theme_stylebox_override("focus", focus)
	return button

func _color(key: String, fallback: Color) -> Color:
	var value: Variant = _palette.get(key, fallback)
	if value is Color:
		return value
	return Color.from_string(value, fallback) if value is String else fallback

func _is_cover() -> bool:
	return str(_options.get("layout", "cards")) == "cover"

func _is_rows() -> bool:
	return _is_cover() and str(_options.get("sourceLayout", "tabs")) == "rows"

func _font_size(role: String, fallback: int) -> int:
	return maxi(1, int(_font_sizes.get(role, fallback)))

func _text(key: String) -> String:
	return str(_strings.get(key, key))

func _chinese() -> Dictionary:
	return {
		"source_heading": "选择存档", "back_local": "返回本地", "row_new": "新旅程", "row_ready": "可继续", "row_invalid": "无法读取", "row_empty": "无存档",
		"row_offline": "未连接", "row_loading": "读取中", "row_working": "处理中", "row_error": "需重试", "row_count": "%d 份存档",
		"eyebrow": "旅程 · 存档", "subtitle": "选择这次旅程的起点", "local_tab": "本地存档", "local_section": "此设备", "local_title": "本地进度",
		"new_title": "开启新的旅程", "new_summary": "此设备还没有存档。可以开始新游戏，或读取云端的进度。",
		"invalid_local": "本地存档无法读取，可尝试云端存档或重新开始。", "continue_local": "继续本地进度", "start_new": "开始新游戏",
		"cloud_section": "云端存档", "cloud_title": "云端进度", "refresh": "刷新", "use_cloud": "读取此存档", "updated": "保存于 ",
		"loading": "正在读取云端存档… 也可以先继续本地进度。", "working": "正在处理存档，请稍候…", "cloud_error": "暂时无法读取云端存档。可以重试，或继续本地游戏。",
		"offline": "当前环境未连接云存档，可以继续本地游戏。", "cloud_empty": "还没有云端存档。", "cloud_ready": "选择要继续的云端进度。",
		"auto_backup": "本局自动备份到云端", "backup_note": "继续云档将更新所选云档；选择本地或新游戏将新建云档。仅本局生效。", "footer": "云端连接失败不影响本地游戏。",
		"new_confirm_title": "开始新的旅程？", "new_confirm_body": "当前设备的本地进度将被替换。已有云端存档不会被修改。",
		"cloud_confirm_title": "读取云端进度？", "cloud_confirm_body": "「%s」将替换此设备的本地进度。尚未备份的本地进度将丢失。",
		"cancel": "取消", "selection_error": "存档操作未完成，请重试或选择其他存档。", "missing_service": "存档服务未配置。"
	}

func _english() -> Dictionary:
	return {
		"source_heading": "Choose a save", "back_local": "Back", "row_new": "New journey", "row_ready": "Ready", "row_invalid": "Unreadable", "row_empty": "No saves",
		"row_offline": "Offline", "row_loading": "Loading", "row_working": "Working", "row_error": "Retry", "row_count": "%d saves",
		"eyebrow": "JOURNEY · SAVES", "subtitle": "Choose where your journey begins", "local_tab": "Local save", "local_section": "ON THIS DEVICE", "local_title": "Local progress",
		"new_title": "A new beginning", "new_summary": "No local save yet. Start a new game or load your progress from the cloud.",
		"invalid_local": "This local save cannot be read. Try a cloud save or start a new game.", "continue_local": "Continue local save", "start_new": "Start new game",
		"cloud_section": "Cloud saves", "cloud_title": "Cloud progress", "refresh": "Refresh", "use_cloud": "Load this save", "updated": "Saved ",
		"loading": "Loading cloud saves… You can continue locally.", "working": "Working on your save…", "cloud_error": "Cloud saves are unavailable. Retry or continue locally.",
		"offline": "Cloud saves are not connected here. You can play locally.", "cloud_empty": "No cloud saves yet.", "cloud_ready": "Choose the cloud progress you want to continue.",
		"auto_backup": "Back up this session to the cloud", "backup_note": "A cloud choice updates that save. Local or new games create a separate cloud save. This session only.", "footer": "Local play stays available without a cloud connection.",
		"new_confirm_title": "Start a new journey?", "new_confirm_body": "This will replace progress on this device. Existing cloud saves will stay unchanged.",
		"cloud_confirm_title": "Load cloud progress?", "cloud_confirm_body": "“%s” will replace progress on this device. Local progress that has not been backed up will be lost.",
		"cancel": "Cancel", "selection_error": "The save operation did not finish. Retry or choose another save.", "missing_service": "The save service is not configured."
	}
