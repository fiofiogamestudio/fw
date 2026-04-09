syntax = "proto3";

message PingAction {}

message PlayerAction {
  oneof payload {
    PingAction ping = 1;
  }
}
