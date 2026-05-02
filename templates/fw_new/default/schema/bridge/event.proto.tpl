syntax = "proto3";

package __LIB_NAME__.bridge;

message StartedEvent {
  string message = 1;
}

message GameEvent {
  oneof payload {
    StartedEvent started = 1;
  }
}
