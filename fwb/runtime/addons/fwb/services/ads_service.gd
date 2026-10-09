extends Node
## Business placements map to provider capabilities; only the host grants game rewards.

signal completed(result: Dictionary)

var _platform: Object
var _options: Dictionary = {}
var _seen_requests: Dictionary = {}
var _session_id := ""
var _disposed := false
var _busy := false
var _last_interstitial := -86400.0


func setup(platform: Object, options: Dictionary = {}) -> void:
	_platform = platform
	_options = options.duplicate(true)
	_session_id = Crypto.new().generate_random_bytes(16).hex_encode()
	process_mode = Node.PROCESS_MODE_ALWAYS


func rewarded(placement: String) -> Dictionary:
	return await _request("rewarded", placement)


func interstitial(placement: String) -> Dictionary:
	return await _request("interstitial", placement)


func dispose() -> void:
	_disposed = true
	_seen_requests.clear()


func _request(kind: String, placement: String) -> Dictionary:
	var result := {"status": "unavailable", "placement": placement, "kind": kind, "grant": null, "reward_eligible": false}
	if _disposed or not is_instance_valid(_platform) or not _options.get("enabled", false):
		return result
	var placements: Variant = _options.get("placements", {})
	if not placements is Dictionary or placements.get(placement) != kind:
		result["message"] = "placement_unconfigured"
		return result
	if _busy:
		result["status"] = "error"
		result["message"] = "busy"
		return result
	if kind == "interstitial":
		var remaining := _last_interstitial + maxf(120.0, float(_options.get("interstitialCooldownSeconds", 120.0))) - float(Time.get_ticks_msec()) / 1000.0
		if remaining > 0:
			result["status"] = "cooldown"
			result["retry_after_ms"] = ceili(remaining * 1000.0)
			return result
	_busy = true
	await _platform.initialize()
	if _disposed:
		_busy = false
		return result
	var response: Dictionary
	if kind == "rewarded":
		response = await _platform.request_rewarded_ad()
	else:
		_last_interstitial = float(Time.get_ticks_msec()) / 1000.0
		response = await _platform.request_commercial_ad()
	_busy = false
	if _disposed:
		return result
	result.merge(response, true)
	result["placement"] = placement
	result["kind"] = kind
	result["grant"] = null
	result["reward_eligible"] = false
	var request_id := str(response.get("request_id", ""))
	if kind == "rewarded" and response.get("status") == "success" and response.get("reward_eligible") == true and not response.get("simulated", false) and not request_id.is_empty() and not _seen_requests.has(request_id):
		_seen_requests[request_id] = true
		result["reward_eligible"] = true
		result["grant"] = {"id": "fwb:" + _session_id + ":" + request_id, "placement": placement, "verified": true}
	completed.emit(result)
	return result
