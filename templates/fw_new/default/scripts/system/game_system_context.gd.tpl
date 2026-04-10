class_name GameSystemContext
extends RefCounted


class Refs extends RefCounted:
	pass


class Config extends RefCounted:
	var project_name: String = ""
	var subtitle: String = ""
	var status_message: String = ""


class State extends RefCounted:
	var press_count: int = 0


var refs: Refs = Refs.new()
var config: Config = Config.new()
var state: State = State.new()
