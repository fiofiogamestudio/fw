syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/common.proto";

message MapSpawnSnapshot {
  Vec2i pos = 1;
}

message MapChunkSnapshot {
  Vec2i coord = 1;
  uint32 revision = 2;
  repeated MapTileRow tile_matrix = 3;
}

message MapTileRow {
  repeated uint32 values = 1;
}

message MapInfoSnapshot {
  uint32 width = 1;
  uint32 height = 2;
  uint32 sync_per_tile = 3;
  uint32 chunk_size = 4;
  repeated MapSpawnSnapshot spawns = 5;
}
