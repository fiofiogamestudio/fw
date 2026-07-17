extends "res://fw/scripts/fw/rt/system/_base_system.gd"

const GAME_BRIDGE_PATH: String = "res://csharp/bridge/game_bridge.cs"
const FCSharpScript = preload("res://fw/scripts/fw/rt/_csharp.gd")

var _bridge: Variant = null


func init(context: Variant) -> bool:
	if not super.init(context):
		return false
	_bridge = FCSharpScript.create_node(GAME_BRIDGE_PATH)
	if _bridge == null:
		push_error("C# game bridge is unavailable. Open the project with Godot .NET and build C# first.")
		return false
	return true


func tick(dt: float) -> void:
	if _bridge == null:
		return
	var intents: Array = _context.take_intents()
	_bridge.tick(dt, intents)
	_context.state.raw_view = _bridge.get_view()
	_context.state.raw_events = _bridge.get_events()
	_context.state.count = int(_context.state.raw_view.get("count", 0))


func shutdown() -> void:
	if _bridge != null:
		_bridge.close()
		if _bridge is Node:
			_bridge.free()
	_bridge = null
	super.shutdown()
