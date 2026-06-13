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
  PACKET_TYPE_HIGH_VIEW = 8;
  PACKET_TYPE_MID_VIEW = 9;
}

message JoinPacket {}

message IntentPacket {
  PlayerIntent player_intent = 1;
}

message JoinAcceptPacket {
  PlayerId player_id = 1;
}

message MapInfoPacket {
  MapInfoView info = 1;
}

message MapChunksPacket {
  repeated MapChunkView chunks = 1;
}

message MapChunkPacket {
  MapChunkView chunk = 1;
}

message SyncFramePacket {
  WorldView view = 1;
  repeated GameEvent events = 2;
}

message HighViewPacket {
  HighView view = 1;
  repeated GameEvent events = 2;
}

message MidViewPacket {
  MidView view = 1;
}

// Runtime packets are Godot dictionaries. type stores one of the generated PacketType string constants.
message Packet {
  string type = 1;
  oneof payload {
    JoinPacket join = 2;
    IntentPacket intent = 3;
    JoinAcceptPacket join_accept = 4;
    MapInfoPacket map_info = 5;
    MapChunksPacket map_chunks = 6;
    MapChunkPacket map_chunk = 7;
    SyncFramePacket sync_frame = 8;
    HighViewPacket high_view = 9;
    MidViewPacket mid_view = 10;
  }
}
