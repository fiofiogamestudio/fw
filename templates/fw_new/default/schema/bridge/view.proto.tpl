syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/value.proto";

message MapSpawnView {
  Vec2i pos = 1;
}

message MapChunkView {
  Vec2i coord = 1;
  uint32 revision = 2;
  repeated MapTileRow tile_matrix = 3;
}

message MapTileRow {
  repeated uint32 values = 1;
}

message MapInfoView {
  uint32 width = 1;
  uint32 height = 2;
  uint32 sync_per_tile = 3;
  uint32 chunk_size = 4;
  repeated MapSpawnView spawns = 5;
}

message EntityView {
  EntityId entity_id = 1;
  EntityKind kind = 2;
  Vec2i pos = 3;
  bool active = 4;
}

message WorldView {
  uint64 tick = 1;
  repeated EntityView entities = 2;
}
