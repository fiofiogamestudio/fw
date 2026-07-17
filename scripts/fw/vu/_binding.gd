class_name FBinding
extends RefCounted

var _connections: Array[Dictionary] = []


func bind_signal(emitter: Object, signal_name: StringName, callable: Callable, flags: int = 0) -> void:
	if emitter == null or not callable.is_valid():
		return
	if emitter.is_connected(signal_name, callable):
		return
	var error: Error = emitter.connect(signal_name, callable, flags)
	if error != OK:
		push_error("FBinding failed to connect signal '%s': %s" % [signal_name, error_string(error)])
		return
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


func bind_view_model(vm: Variant, callable: Callable, immediate: bool = true) -> void:
	bind_vm(vm, callable, immediate)


func unbind() -> void:
	for entry in _connections:
		var raw_emitter: Variant = entry.get("emitter", null)
		var signal_name: StringName = entry.get("signal", &"")
		var callable: Callable = entry.get("callable", Callable())
		if not is_instance_valid(raw_emitter) or not (raw_emitter is Object):
			continue
		var emitter: Object = raw_emitter
		if callable.is_valid() \
				and emitter.is_connected(signal_name, callable):
			emitter.disconnect(signal_name, callable)
	_connections.clear()


func clear() -> void:
	unbind()
