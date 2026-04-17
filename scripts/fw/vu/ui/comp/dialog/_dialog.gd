@tool
class_name FDialog
extends "res://fw/scripts/fw/vu/ui/form/_form.gd"

signal confirmed
signal cancelled


func confirm() -> void:
	confirmed.emit()


func cancel() -> void:
	cancelled.emit()
