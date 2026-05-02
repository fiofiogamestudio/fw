syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/input.proto";
import "schema/bridge/map.proto";
import "schema/bridge/snapshot.proto";
import "schema/bridge/event.proto";

enum NetPacketType {
  NET_PACKET_TYPE_UNSPECIFIED = 0;
  NET_PACKET_TYPE_JOIN = 1;
  NET_PACKET_TYPE_INPUT = 2;
  NET_PACKET_TYPE_JOIN_ACCEPT = 3;
  NET_PACKET_TYPE_MAP_INFO = 4;
  NET_PACKET_TYPE_MAP_CHUNKS = 5;
  NET_PACKET_TYPE_MAP_CHUNK = 6;
  NET_PACKET_TYPE_SYNC_FRAME = 7;
}

message NetPacket {
  string type = 1;
  PlayerCommand cmd = 2;
  uint32 player_id = 3;
  MapInfoSnapshot map_info = 4;
  repeated MapChunkSnapshot chunks = 5;
  MapChunkSnapshot chunk = 6;
  WorldSnapshot snapshot = 7;
  repeated GameEvent events = 8;
}
