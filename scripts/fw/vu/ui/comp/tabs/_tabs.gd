@tool
class_name FTabs
extends "res://fw/scripts/fw/vu/ui/widget/_widget.gd"

const FSelectionScript = preload("../list/_selection.gd")

@export var button_ref_keys: Array[StringName] = []
@export var page_ref_keys: Array[StringName] = []

signal tab_changed(index: int)

var _buttons: Array[Variant] = []
var _pages: Array[Control] = []
var _selection: Variant = null


func on_setup() -> void:
	_buttons.clear()
	_pages.clear()
	for key in button_ref_keys:
		var button: Variant = require_ref(key, Button)
		if button:
			_buttons.append(button)
	for key in page_ref_keys:
		var page := require_ref(key, Control) as Control
		if page:
			_pages.append(page)
	_selection = FSelectionScript.new()
	_selection.setup(false)
	for i in range(_buttons.size()):
		var button: Variant = _buttons[i]
		var binding = create_binding()
		binding.bind_signal(button, &"pressed", Callable(self, "_on_tab_triggered").bind(i))
	if not _buttons.is_empty():
		select_tab(0)


func on_clear() -> void:
	_buttons.clear()
	_pages.clear()
	_selection = null


func select_tab(index: int) -> void:
	if _selection == null:
		return
	_selection.select(index)
	for i in range(_pages.size()):
		_pages[i].visible = i == index
	tab_changed.emit(index)


func selected_index() -> int:
	if _selection == null:
		return -1
	return _selection.primary_index()


func _on_tab_triggered(index: int) -> void:
	select_tab(index)
