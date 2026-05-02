syntax = "proto3";

package __LIB_NAME__.bridge;

message PlayerId {
  uint32 value = 1;
}

message EntityId {
  uint32 value = 1;
}

message Vec2i {
  int32 x = 1;
  int32 y = 2;
}
