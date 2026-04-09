syntax = "proto3";

message EntitySnapshot {
  uint32 id = 1;
  string label = 2;
  Vec2i pos = 3;
}

message WorldSnapshot {
  uint32 tick = 1;
  repeated EntitySnapshot entities = 2;
}
