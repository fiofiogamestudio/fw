@tool
class_name FListItem
extends "res://fw/scripts/fw/vu/ui/widget/_widget.gd"

@export var template_mode: bool = false

var _item_data: Variant = null
var _item_index: int = -1
var _owner_list: Variant = null


func bind_item(owner_list: Variant, index: int, data: Variant, selected: bool) -> void:
	_owner_list = owner_list
	_item_index = index
	_item_data = data
	render_item(data, index, selected)


func render_item(_data: Variant, _index: int, _selected: bool) -> void:
	pass


func set_selected(selected: bool) -> void:
	render_item(_item_data, _item_index, selected)


func item_index() -> int:
	return _item_index


func item_data() -> Variant:
	return _item_data


func owner_list() -> Variant:
	return _owner_list


func set_template_mode(value: bool) -> void:
	template_mode = value


func skip_auto_widget_setup() -> bool:
	return template_mode


func _gui_input(event: InputEvent) -> void:
	if template_mode:
		return
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
			if _owner_list != null:
				_owner_list.press_index(_item_index, event.ctrl_pressed)
			accept_event()
