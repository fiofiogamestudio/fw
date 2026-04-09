class_name FBinding
extends RefCounted

var _connections: Array[Dictionary] = []


func bind_signal(emitter: Object, signal_name: StringName, callable: Callable, flags: int = 0) -> void:
	if emitter == null or not callable.is_valid():
		return
	if not emitter.is_connected(signal_name, callable):
		emitter.connect(signal_name, callable, flags)
	_connections.append({
		"emitter": emitter,
		"signal": signal_name,
		"callable": callable,
	})


func bind_vm(vm: Variant, callable: Callable, immediate: bool = true) -> void:
	if vm == null or not callable.is_valid():
		return
	bind_signal(vm, &"changed", callable)
	if immediate:
		callable.call(&"")


func unbind() -> void:
	for entry in _connections:
		var emitter: Object = entry.get("emitter", null)
		var signal_name: StringName = entry.get("signal", &"")
		var callable: Callable = entry.get("callable", Callable())
		if emitter != null and callable.is_valid() and emitter.is_connected(signal_name, callable):
			emitter.disconnect(signal_name, callable)
	_connections.clear()
