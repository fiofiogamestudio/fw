class_name FSelection
extends RefCounted

signal changed

var _allow_multi: bool = false
var _selected_indices: Array[int] = []


func setup(allow_multi: bool = false) -> void:
	_allow_multi = allow_multi
	_selected_indices.clear()


func clear() -> void:
	if _selected_indices.is_empty():
		return
	_selected_indices.clear()
	changed.emit()


func select(index: int, additive: bool = false) -> void:
	var next_selected: Array[int] = []
	if _allow_multi and additive:
		next_selected = _selected_indices.duplicate()
		if not next_selected.has(index):
			next_selected.append(index)
	else:
		next_selected = [index]
	if next_selected == _selected_indices:
		return
	_selected_indices = next_selected
	changed.emit()


func toggle(index: int) -> void:
	var next_selected: Array[int] = _selected_indices.duplicate()
	if next_selected.has(index):
		next_selected.erase(index)
	else:
		if not _allow_multi:
			next_selected.clear()
		next_selected.append(index)
	if next_selected == _selected_indices:
		return
	_selected_indices = next_selected
	changed.emit()


func is_selected(index: int) -> bool:
	return _selected_indices.has(index)


func selected_indices() -> Array[int]:
	return _selected_indices.duplicate()


func primary_index() -> int:
	if _selected_indices.is_empty():
		return -1
	return _selected_indices[0]
