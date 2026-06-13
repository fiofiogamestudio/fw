syntax = "proto3";

message GameConfig {
  string title = 1;
  uint32 net_view_rate = 2;
  uint32 net_mid_view_rate = 3;
}
