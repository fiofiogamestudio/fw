syntax = "proto3";

message GameConfig {
  string title = 1;
  uint32 net_view_rate = 2;
  uint32 net_mid_view_rate = 3;
  uint32 net_max_peers = 4;
  uint32 net_max_packets_per_poll = 5;
  uint32 net_client_timeout_ms = 6;
  uint32 net_client_keepalive_ms = 7;
  uint32 net_join_payload_retry_ms = 8;
}
