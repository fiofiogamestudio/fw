syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/intent.proto";
import "schema/bridge/view.proto";
import "schema/bridge/event.proto";

enum PacketType {
  PACKET_TYPE_UNSPECIFIED = 0;
  PACKET_TYPE_JOIN = 1;
  PACKET_TYPE_INTENT = 2;
  PACKET_TYPE_JOIN_ACCEPT = 3;
  PACKET_TYPE_MAP_INFO = 4;
  PACKET_TYPE_MAP_CHUNKS = 5;
  PACKET_TYPE_MAP_CHUNK = 6;
  PACKET_TYPE_SYNC_FRAME = 7;
}

message Packet {
  string type = 1;
  PlayerIntent intent = 2;
  uint32 player_id = 3;
  MapInfoView map_info = 4;
  repeated MapChunkView chunks = 5;
  MapChunkView chunk = 6;
  WorldView view = 7;
  repeated GameEvent events = 8;
}
