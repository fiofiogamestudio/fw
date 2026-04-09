class_name GameContext
extends RefCounted


class Refs extends RefCounted:
	pass


class Args extends RefCounted:
	var form_manager: Variant = null
	var mode_context: Variant = null


class State extends RefCounted:
	var logic: RefCounted = null


var refs: Refs = Refs.new()
var args: Args = Args.new()
var state: State = State.new()
