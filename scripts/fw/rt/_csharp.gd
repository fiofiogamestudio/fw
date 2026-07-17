class_name FCSharp
extends RefCounted


static func create_node(script_path: String) -> Node:
	if not FileAccess.file_exists(script_path):
		push_error("C# script not found: %s" % script_path)
		return null

	var script: Script = load(script_path) as Script
	if script == null:
		push_error("C# script failed to load: %s" % script_path)
		return null

	var node: Node = Node.new()
	node.set_script(script)
	if node.get_script() != script:
		node.free()
		push_error("C# script failed to attach to Node: %s" % script_path)
		return null
	return node
