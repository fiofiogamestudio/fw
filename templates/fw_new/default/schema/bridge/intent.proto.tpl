syntax = "proto3";

package __LIB_NAME__.bridge;

import "schema/bridge/value.proto";

enum PlayerButton {
  PLAYER_BUTTON_UNSPECIFIED = 0;
  PLAYER_BUTTON_PRIMARY = 1;
  PLAYER_BUTTON_SECONDARY = 2;
  PLAYER_BUTTON_SPRINT = 4;
  PLAYER_BUTTON_INTERACT = 8;
}

message PingIntent {}

message PlayerAction {
  oneof kind {
    PingIntent ping = 1;
  }
}

message PlayerIntent {
  PlayerId player_id = 1;
  uint32 client_tick = 2;
  Vec2i move_dir = 3;
  Vec2i aim_dir = 4;
  uint32 buttons_hold = 5;
  uint32 buttons_down = 6;
  uint32 buttons_up = 7;
  PlayerAction action = 8;
}
