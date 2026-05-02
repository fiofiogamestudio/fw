syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/common.proto";

message EntitySnapshot {
  uint32 id = 1;
  string label = 2;
  Vec2i pos = 3;
}

message WorldSnapshot {
  uint32 tick = 1;
  repeated EntitySnapshot entities = 2;
}
