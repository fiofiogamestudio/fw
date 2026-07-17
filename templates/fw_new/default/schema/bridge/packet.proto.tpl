syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/intent.proto";
import "schema/bridge/view.proto";
import "schema/bridge/event.proto";

enum PacketType {
  PACKET_TYPE_UNSPECIFIED = 0;
  PACKET_TYPE_INTENT = 1;
  PACKET_TYPE_VIEW = 2;
  PACKET_TYPE_EVENTS = 3;
}

message IntentPacket {
  GameIntent intent = 1;
}

message ViewPacket {
  GameView view = 1;
}

message EventsPacket {
  repeated GameEvent events = 2;
}

message Packet {
  string type = 1;
  uint32 protocol_version = 2;
  string session_token = 3;
  oneof payload {
    IntentPacket intent = 10;
    ViewPacket view = 11;
    EventsPacket events = 12;
  }
}
