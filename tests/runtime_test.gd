extends SceneTree

const BindingScript = preload("res://fw/scripts/fw/vu/_binding.gd")
const PoolScript = preload("res://fw/scripts/fw/rt/pool/_pool.gd")
const AssetScript = preload("res://fw/scripts/fw/rt/_asset.gd")
const AppRootScript = preload("res://fw/scripts/fw/rt/system/_app_root.gd")
const BaseModeScript = preload("res://fw/scripts/fw/rt/system/_base_mode.gd")
const BaseSystemScript = preload("res://fw/scripts/fw/rt/system/_base_system.gd")
const SystemManagerScript = preload("res://fw/scripts/fw/rt/system/_system_manager.gd")
const ViewStoreScript = preload("res://fw/scripts/fw/vu/_view_store.gd")
const ViewRootScript = preload("res://fw/scripts/fw/vu/_view_root.gd")
const FFxScript = preload("res://fw/scripts/fw/vu/fx/_fx.gd")
const FFormScript = preload("res://fw/scripts/fw/vu/ui/form/_form.gd")
const FFormLogicScript = preload("res://fw/scripts/fw/vu/ui/form/_form_logic.gd")
const FFormsScript = preload("res://fw/scripts/fw/vu/ui/form/_forms.gd")
const FUIScript = preload("res://fw/scripts/fw/vu/ui/_ui.gd")
const FWidgetScript = preload("res://fw/scripts/fw/vu/ui/widget/_widget.gd")

const API_SNAPSHOT_PATH := "res://fw/tests/contracts/godot_api.json"
const FW_SCRIPT_ROOT := "res://fw/scripts/fw"

var _failures: Array[String] = []


class SignalProbe:
	extends RefCounted

	signal changed(value: int)


class NodeSignalProbe:
	extends Node

	signal changed(value: int)


class SystemProbe:
	extends RefCounted

	var calls: Array[String]
	var id: String
	var succeeds: bool

	func _init(call_log: Array[String], system_id: String, init_succeeds: bool) -> void:
		calls = call_log
		id = system_id
		succeeds = init_succeeds

	func init(_context: Variant) -> bool:
		calls.append("init:%s" % id)
		return succeeds

	func tick(_dt: float) -> void:
		calls.append("tick:%s" % id)

	func shutdown() -> void:
		calls.append("shutdown:%s" % id)


class ModeProbe:
	extends RefCounted

	var calls: Array[String]
	var succeeds: bool

	func _init(call_log: Array[String], enter_succeeds: bool) -> void:
		calls = call_log
		succeeds = enter_succeeds

	func enter(app: Variant, _context: Variant) -> bool:
		calls.append("enter")
		var child: Node = Node.new()
		child.name = "PartialMode"
		app.mode_host().add_child(child)
		return succeeds

	func tick(_dt: float) -> void:
		calls.append("tick")

	func exit() -> void:
		calls.append("exit")


func _init() -> void:
	call_deferred("_run")


func _run() -> void:
	_test_public_api()
	_test_binding()
	_test_pool()
	_test_view_store()
	_test_ui_stack()
	_test_system_rollback()
	_test_mode_rollback()
	if _failures.is_empty():
		print("fw Godot runtime tests passed.")
		quit(0)
		return
	for failure in _failures:
		printerr("[runtime-test] %s" % failure)
	quit(1)


func _test_public_api() -> void:
	_test_exact_public_api()
	_check_methods(AssetScript.new(), [&"load", &"unload"], "FAsset")
	_check_methods(PoolScript.new(), [&"setup", &"register_prefab", &"spawn", &"recycle", &"flush"], "FPool")
	_check_methods(BaseModeScript.new(), [&"enter", &"tick", &"exit", &"add_system", &"init_systems"], "BaseMode")
	_check_methods(BaseSystemScript.new(), [&"init", &"tick", &"shutdown"], "BaseSystem")
	_check_methods(SystemManagerScript.new(), [&"set_phase_order", &"add_system", &"init_all", &"tick", &"shutdown_all"], "SystemManager")
	_check_methods(FUIScript.new(), [&"setup", &"clear", &"open", &"close", &"close_all"], "FUI")
	_check_methods(ViewRootScript.new(), [&"setup", &"clear", &"apply"], "FViewRoot")
	_check_methods(FFormScript.new(), [&"setup", &"clear", &"apply"], "FForm")
	_check_methods(FWidgetScript.new(), [&"setup", &"clear", &"apply"], "FWidget")
	var fx: Variant = FFxScript.new()
	_check(fx.has_signal(&"finished"), "FFx must keep the finished signal")
	_check_methods(fx, [&"setup", &"clear", &"play"], "FFx")


func _test_exact_public_api() -> void:
	var actual: Dictionary = _public_api_snapshot()
	if OS.get_environment("FW_UPDATE_API") == "1":
		var output: FileAccess = FileAccess.open(API_SNAPSHOT_PATH, FileAccess.WRITE)
		_check(output != null, "Godot API snapshot must be writable")
		if output != null:
			output.store_string(JSON.stringify(actual, "\t") + "\n")
			output.close()
	var file: FileAccess = FileAccess.open(API_SNAPSHOT_PATH, FileAccess.READ)
	_check(file != null, "Godot API snapshot must exist")
	if file == null:
		return
	var expected_raw: Variant = JSON.parse_string(file.get_as_text())
	_check(expected_raw is Dictionary, "Godot API snapshot must be valid JSON")
	if not (expected_raw is Dictionary):
		return
	var expected: Dictionary = expected_raw
	if actual != expected:
		printerr("[runtime-test] Godot public API changed. Review compatibility, then update %s:\n%s" % [
			API_SNAPSHOT_PATH,
			JSON.stringify(actual, "\t"),
		])
		_failures.append("Godot public API snapshot mismatch")


func _public_api_snapshot() -> Dictionary:
	var scripts: Dictionary = {}
	_collect_public_scripts(FW_SCRIPT_ROOT, scripts)
	var snapshot: Dictionary = {}
	var labels: Array = scripts.keys()
	labels.sort()
	for label: String in labels:
		var script: Script = scripts[label]
		snapshot[label] = _script_api(script)
	return snapshot


func _collect_public_scripts(path: String, scripts: Dictionary) -> void:
	var directory: DirAccess = DirAccess.open(path)
	_check(directory != null, "framework script directory must exist: %s" % path)
	if directory == null:
		return
	directory.list_dir_begin()
	var entry: String = directory.get_next()
	while not entry.is_empty():
		if not entry.begins_with("."):
			var child_path: String = path.path_join(entry)
			if directory.current_is_dir():
				_collect_public_scripts(child_path, scripts)
			elif entry.ends_with(".gd"):
				var resource: Resource = load(child_path)
				if resource is Script:
					var script: Script = resource
					var global_name: String = str(script.get_global_name())
					if not global_name.is_empty():
						_check(not scripts.has(global_name), "duplicate framework class_name: %s" % global_name)
						scripts[global_name] = script
		entry = directory.get_next()
	directory.list_dir_end()


func _script_api(script: Script) -> Dictionary:
	var api: Dictionary = _all_script_api(script)
	var base_script: Script = script.get_base_script()
	api["base"] = _script_base_name(script, base_script)
	if base_script == null:
		return api
	var inherited: Dictionary = _all_script_api(base_script)
	for section: String in ["methods", "signals", "properties", "constants"]:
		api[section] = _without(api[section], inherited[section])
	return api


func _script_base_name(script: Script, base_script: Script) -> String:
	if base_script != null:
		var global_name: String = str(base_script.get_global_name())
		return global_name if not global_name.is_empty() else str(base_script.resource_path)
	return str(script.get_instance_base_type())


func _all_script_api(script: Script) -> Dictionary:
	var methods: Array[String] = []
	for raw_method: Dictionary in script.get_script_method_list():
		var method_name: String = str(raw_method.get("name", ""))
		if method_name.begins_with("_"):
			continue
		var args: Array[String] = []
		for raw_arg: Dictionary in raw_method.get("args", []):
			args.append("%s:%s" % [str(raw_arg.get("name", "")), _api_type(raw_arg)])
		var returns: Dictionary = raw_method.get("return", {})
		var defaults: Array = raw_method.get("default_args", [])
		var default_values: Array[String] = []
		for value: Variant in defaults:
			default_values.append(var_to_str(value))
		methods.append("%s(%s)->%s;defaults=[%s]" % [
			method_name,
			", ".join(args),
			_api_type(returns),
			", ".join(default_values),
		])
	methods = _unique_sorted(methods)

	var signals: Array[String] = []
	for raw_signal: Dictionary in script.get_script_signal_list():
		var args: Array[String] = []
		for raw_arg: Dictionary in raw_signal.get("args", []):
			args.append("%s:%s" % [str(raw_arg.get("name", "")), _api_type(raw_arg)])
		signals.append("%s(%s)" % [str(raw_signal.get("name", "")), ", ".join(args)])
	signals = _unique_sorted(signals)

	var properties: Array[String] = []
	for raw_property: Dictionary in script.get_script_property_list():
		var property_name: String = str(raw_property.get("name", ""))
		if not property_name.begins_with("_"):
			properties.append("%s:%s" % [property_name, _api_type(raw_property)])
	properties = _unique_sorted(properties)

	var constants: Array[String] = []
	var constant_map: Dictionary = script.get_script_constant_map()
	for constant_name: String in constant_map:
		var value: Variant = constant_map[constant_name]
		if not constant_name.begins_with("_") and not (value is Script):
			constants.append("%s:%s=%s" % [constant_name, type_string(typeof(value)), var_to_str(value)])
	constants = _unique_sorted(constants)
	return {
		"methods": methods,
		"signals": signals,
		"properties": properties,
		"constants": constants,
	}


func _unique_sorted(values: Array[String]) -> Array[String]:
	var seen: Dictionary = {}
	for value: String in values:
		seen[value] = true
	var result: Array[String] = []
	for value: String in seen:
		result.append(value)
	result.sort()
	return result


func _without(values: Array, inherited: Array) -> Array[String]:
	var inherited_set: Dictionary = {}
	for value: String in inherited:
		inherited_set[value] = true
	var result: Array[String] = []
	for value: String in values:
		if not inherited_set.has(value):
			result.append(value)
	return result


func _api_type(info: Dictionary) -> String:
	var script_class: String = str(info.get("class_name", ""))
	if not script_class.is_empty():
		return script_class
	var type_id: int = int(info.get("type", TYPE_NIL))
	var hint: String = str(info.get("hint_string", ""))
	return type_string(type_id) if hint.is_empty() else "%s[%s]" % [type_string(type_id), hint]


func _check_methods(instance: Variant, methods: Array[StringName], label: String) -> void:
	for method in methods:
		_check(instance.has_method(method), "%s must keep method %s" % [label, method])
	if instance is Node:
		instance.free()


func _test_binding() -> void:
	var emitter: SignalProbe = SignalProbe.new()
	var binding: Variant = BindingScript.new()
	var state: Dictionary = {"calls": 0}
	var callback: Callable = func(_value: int) -> void:
		state["calls"] = int(state["calls"]) + 1
	binding.bind_signal(emitter, &"changed", callback)
	binding.bind_signal(emitter, &"changed", callback)
	emitter.changed.emit(1)
	_check(int(state["calls"]) == 1, "binding must reject duplicate connections")
	binding.unbind()
	emitter.changed.emit(2)
	_check(int(state["calls"]) == 1, "binding must disconnect owned connections")

	var external_emitter: SignalProbe = SignalProbe.new()
	var external_state: Dictionary = {"calls": 0}
	var external_callback: Callable = func(_value: int) -> void:
		external_state["calls"] = int(external_state["calls"]) + 1
	external_emitter.changed.connect(external_callback)
	var observer: Variant = BindingScript.new()
	observer.bind_signal(external_emitter, &"changed", external_callback)
	observer.unbind()
	external_emitter.changed.emit(3)
	_check(int(external_state["calls"]) == 1, "binding must not disconnect an external connection")
	external_emitter.changed.disconnect(external_callback)

	var freed_emitter: NodeSignalProbe = NodeSignalProbe.new()
	root.add_child(freed_emitter)
	var freed_binding: Variant = BindingScript.new()
	freed_binding.bind_signal(freed_emitter, &"changed", callback)
	freed_emitter.free()
	freed_binding.unbind()


func _test_pool() -> void:
	var pool: Variant = PoolScript.new()
	var packed: PackedScene = PackedScene.new()
	var source: Node = Node.new()
	_check(packed.pack(source) == OK, "pool fixture must pack")
	source.free()
	pool.register_prefab("node", packed, 1)
	var first: Node = pool.spawn("node")
	_check(first != null, "pool must spawn without a default parent")
	pool.recycle(first)
	pool.recycle(first)
	var second: Node = pool.spawn("node")
	_check(second == first, "pool must reuse a recycled node")
	var third: Node = pool.spawn("node")
	_check(third != first, "pool must not return one recycled node twice")
	pool.recycle(second)
	pool.recycle(third)
	var externally_freed: Node = pool.spawn("node")
	externally_freed.free()
	pool.flush()


func _test_view_store() -> void:
	var owner: Node = Node.new()
	root.add_child(owner)
	var first: Node = Node.new()
	first.name = "Target"
	owner.add_child(first)
	var store: Variant = ViewStoreScript.new()
	store.setup(owner, {&"target": ^"Target"}, {})
	_check(store.require_node(^"Target") == first, "view store must resolve its initial node")
	_check(store.require_ref(&"target") == first, "ref store must resolve its initial node")
	owner.remove_child(first)
	first.free()
	var replacement: Node = Node.new()
	replacement.name = "Target"
	owner.add_child(replacement)
	_check(store.require_node(^"Target") == replacement, "view store must replace an invalid cached node")
	_check(store.require_ref(&"target") == replacement, "ref store must replace an invalid cached node")
	store.clear()
	owner.free()


func _test_system_rollback() -> void:
	var calls: Array[String] = []
	var manager: Variant = SystemManagerScript.new()
	manager.set_phase_order([&"first", &"second"])
	_check(manager.add_system(&"first", SystemProbe.new(calls, "first", true), RefCounted.new(), &"first"), "first system must register")
	_check(manager.add_system(&"second", SystemProbe.new(calls, "second", false), RefCounted.new(), &"second"), "second system must register")
	_check(not manager.init_all(), "manager must reject a failed system init")
	_check(
		",".join(calls) == "init:first,init:second,shutdown:second,shutdown:first",
		"manager must roll back attempted systems in reverse order"
	)
	manager.shutdown_all()


func _test_mode_rollback() -> void:
	var app: Variant = AppRootScript.new()
	root.add_child(app)
	var calls: Array[String] = []
	var mode: ModeProbe = ModeProbe.new(calls, false)
	_check(app.switch_mode(mode) == null, "app root must reject a failed mode enter")
	_check(",".join(calls) == "enter,exit", "app root must exit a partially entered mode")
	_check(app.mode_host().get_child_count() == 0, "app root must clear partial mode nodes")
	app.free()


func _test_ui_stack() -> void:
	var source: Control = Control.new()
	source.set_script(FFormScript)
	var packed: PackedScene = PackedScene.new()
	_check(packed.pack(source) == OK, "form fixture must pack")
	source.free()

	var host: CanvasLayer = CanvasLayer.new()
	root.add_child(host)
	var ui: Variant = FUIScript.new()
	ui.setup(host)
	var initial_root: Control = ui.root()
	ui.setup(host)
	_check(ui.root() != initial_root and host.get_child_count() == 1, "UI setup must replace its root without leaking")

	var invalid_source: Control = Control.new()
	var invalid_packed: PackedScene = PackedScene.new()
	_check(invalid_packed.pack(invalid_source) == OK, "invalid form fixture must pack")
	invalid_source.free()
	_check(ui.open(FUIScript.LAYER_SCREEN, &"invalid", invalid_packed) == null, "UI must reject non-form scenes")
	_check(not ui.has(&"invalid"), "failed UI open must not leave a registered form")

	var first: Variant = ui.open(FUIScript.LAYER_SCREEN, &"first", packed)
	var second: Variant = ui.open(FUIScript.LAYER_SCREEN, &"second", packed)
	_check(first != null and second != null, "UI must open valid forms")
	_check(not first.visible and second.visible, "screen stack must hide its previous form")
	var third: Variant = ui.open(FUIScript.LAYER_SCREEN, &"third", packed)
	_check(third != null and not second.visible, "screen stack must hide the second form")
	third.free()
	ui.close(&"third")
	_check(second.visible, "closing an externally freed screen must reveal the previous form")
	ui.close(&"second")
	_check(first.visible, "closing the top screen must reveal the previous form")
	ui.clear()
	host.free()

	var forms_host: CanvasLayer = CanvasLayer.new()
	root.add_child(forms_host)
	var forms: Variant = FFormsScript.new()
	forms.setup(forms_host)
	var forms_root: Control = forms.ui().root()
	forms.setup(forms_host)
	_check(forms.ui().root() != forms_root and forms_host.get_child_count() == 1, "FForms setup must be idempotent")
	var logic: Variant = FFormLogicScript.new()
	logic.attach_ui(forms.ui())
	_check(logic.open(FUIScript.LAYER_SCREEN, &"logic", packed) != null, "form logic must open a form")
	logic.detach_ui()
	_check(not forms.has(&"logic"), "detaching form logic must close its owned form")
	forms.clear()
	_check(forms_host.get_child_count() == 0, "FForms clear must release its UI root")
	forms_host.free()


func _check(value: bool, message: String) -> void:
	if not value:
		_failures.append(message)
