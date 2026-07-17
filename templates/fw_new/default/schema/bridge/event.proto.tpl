syntax = "proto3";

package __LIB_NAME__.bridge;

message CountChangedEvent {
  uint32 count = 1;
}

message GameEvent {
  oneof payload {
    CountChangedEvent count_changed = 1;
  }
}
