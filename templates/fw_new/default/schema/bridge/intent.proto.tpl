syntax = "proto3";

package __LIB_NAME__.bridge;

message IncrementIntent {
  uint32 amount = 1;
}

message GameAction {
  oneof kind {
    IncrementIntent increment = 1;
  }
}

message GameIntent {
  GameAction action = 1;
}
