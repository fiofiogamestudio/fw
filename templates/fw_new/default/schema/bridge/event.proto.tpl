syntax = "proto3";

message StartedEvent {
  string message = 1;
}

message GameEvent {
  oneof payload {
    StartedEvent started = 1;
  }
}
