@tool
class_name FList
extends "res://fw/scripts/fw/vu/ui/widget/_widget.gd"

const FSelectionScript = preload("_selection.gd")
const FListItemScript = preload("_list_item.gd")
const FWidgetScript = preload("../../widget/_widget.gd")

signal item_pressed(index: int, data: Variant)

@export var item_scene: PackedScene
@export var content_ref_key: StringName = &"content"
@export var template_ref_key: StringName = &"template"
@export var allow_multi_select: bool = false

var _content_root: Node = null
var _items: Array = []
var _item_nodes: Array[Variant] = []
var _selection: Variant = null
var _template_item: Variant = null


func on_setup() -> void:
	_content_root = require_ref(content_ref_key)
	_selection = FSelectionScript.new()
	_selection.setup(allow_multi_select)
	_template_item = _resolve_template_item()
	if _template_item:
		_template_item.visible = false
		if is_instance_of(_template_item, FListItemScript):
			_template_item.set_template_mode(true)


func on_clear() -> void:
	clear_items()
	_template_item = null
	_content_root = null
	_selection = null


func set_items(items: Array) -> void:
	_items = items.duplicate(true)
	refresh()


func apply(vm: Variant, _dt: float = 0.0) -> void:
	if vm is Array:
		set_items(vm)
	elif vm is Dictionary:
		set_items(vm.get("items", []))


func items() -> Array:
	return _items.duplicate(true)


func refresh() -> void:
	clear_items()
	if _content_root == null:
		return
	for i in range(_items.size()):
		var item: Variant = _instantiate_item()
		if item == null:
			return
		_content_root.add_child(item)
		if is_instance_of(item, FWidgetScript):
			item.setup(owner_form())
		item.bind_item(self, i, _items[i], _selection.is_selected(i))
		_item_nodes.append(item)


func refresh_item(index: int) -> void:
	if index < 0 or index >= _item_nodes.size():
		return
	var item: Variant = _item_nodes[index]
	if item:
		item.bind_item(self, index, _items[index], _selection.is_selected(index))


func clear_items() -> void:
	for item in _item_nodes:
		if item and is_instance_of(item, FWidgetScript):
			item.clear()
		if is_instance_valid(item):
			item.queue_free()
	_item_nodes.clear()
	if _selection:
		_selection.clear()


func select_index(index: int, additive: bool = false) -> void:
	if _selection == null:
		return
	_selection.select(index, additive)
	_sync_selection_state()


func toggle_index(index: int) -> void:
	if _selection == null:
		return
	_selection.toggle(index)
	_sync_selection_state()


func clear_selection() -> void:
	if _selection == null:
		return
	_selection.clear()
	_sync_selection_state()


func selected_indices() -> Array[int]:
	if _selection == null:
		return []
	return _selection.selected_indices()


func selection() -> Variant:
	return _selection


func press_index(index: int, additive: bool = false) -> void:
	if index < 0 or index >= _items.size():
		return
	if allow_multi_select and additive:
		toggle_index(index)
	else:
		select_index(index, additive)
	var data: Variant = _items[index]
	item_pressed.emit(index, data)
	emit_action(&"item_pressed", {"index": index, "data": data})


func _sync_selection_state() -> void:
	for i in range(_item_nodes.size()):
		var item: Variant = _item_nodes[i]
		if item:
			item.set_selected(_selection.is_selected(i))


func _resolve_template_item() -> Variant:
	if has_ref(template_ref_key):
		var template: Variant = get_ref(template_ref_key)
		if template != null and not is_instance_of(template, FListItemScript):
			push_error("FList template must extend FListItem.")
			return null
		return template
	return null


func _instantiate_item() -> Variant:
	if _template_item != null:
		var template_clone: Variant = _template_item.duplicate()
		if template_clone == null or not is_instance_of(template_clone, FListItemScript):
			push_error("FList template clone must extend FListItem.")
			if template_clone is Node:
				template_clone.queue_free()
			return null
		template_clone.visible = true
		template_clone.set_template_mode(false)
		return template_clone
	if item_scene == null:
		push_error("FList requires either a template ref or an item_scene.")
		return null
	var scene_item: Variant = item_scene.instantiate()
	if scene_item == null or not is_instance_of(scene_item, FListItemScript):
		push_error("FList item_scene root must extend FListItem.")
		if scene_item is Node:
			scene_item.queue_free()
		return null
	return scene_item
