syntax = "proto3";

package __LIB_NAME__.bridge;

message PingAction {}

message PlayerAction {
  oneof payload {
    PingAction ping = 1;
  }
}
