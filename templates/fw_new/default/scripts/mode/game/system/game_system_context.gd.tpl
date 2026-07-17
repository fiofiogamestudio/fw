class_name GameSystemContext
extends RefCounted

const Bridge = preload("res://scripts/_gen/_bridge.gd")


class Refs extends RefCounted:
	pass


class Config extends RefCounted:
	var project_name: String = ""
	var subtitle: String = ""
	var status_message: String = ""


class State extends RefCounted:
	var count: int = 0
	var pending_intents: Array = []
	var raw_view: Dictionary = {}
	var raw_events: Array = []


var refs: Refs = Refs.new()
var config: Config = Config.new()
var state: State = State.new()


func request_increment() -> void:
	state.pending_intents.append(Bridge.Intent.increment(1))


func take_intents() -> Array:
	var intents: Array = state.pending_intents
	state.pending_intents = []
	return intents
