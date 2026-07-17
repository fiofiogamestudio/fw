extends SceneTree

const BindingScript = preload("res://fw/scripts/fw/vu/_binding.gd")
const PoolScript = preload("res://fw/scripts/fw/rt/pool/_pool.gd")
const AppRootScript = preload("res://fw/scripts/fw/rt/system/_app_root.gd")
const SystemManagerScript = preload("res://fw/scripts/fw/rt/system/_system_manager.gd")
const ViewStoreScript = preload("res://fw/scripts/fw/vu/_view_store.gd")
const FFormScript = preload("res://fw/scripts/fw/vu/ui/form/_form.gd")
const FFormLogicScript = preload("res://fw/scripts/fw/vu/ui/form/_form_logic.gd")
const FFormsScript = preload("res://fw/scripts/fw/vu/ui/form/_forms.gd")
const FUIScript = preload("res://fw/scripts/fw/vu/ui/_ui.gd")

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
