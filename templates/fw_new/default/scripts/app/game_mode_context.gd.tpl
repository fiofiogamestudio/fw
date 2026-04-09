class_name GameModeContext
extends RefCounted


class Refs extends RefCounted:
	pass


class Config extends RefCounted:
	var project_name: String = "__PROJECT_NAME_PASCAL__"
	var subtitle: String = "Fw New Scaffold"
	var status_message: String = ""


var refs: Refs = Refs.new()
var config: Config = Config.new()
