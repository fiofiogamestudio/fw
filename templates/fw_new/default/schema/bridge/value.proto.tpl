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

enum EntityKind {
  ENTITY_KIND_UNSPECIFIED = 0;
  ENTITY_KIND_PLAYER = 1;
}

enum ItemKind {
  ITEM_KIND_UNSPECIFIED = 0;
  ITEM_KIND_ITEM = 1;
}

enum WeaponSlot {
  WEAPON_SLOT_UNSPECIFIED = 0;
  WEAPON_SLOT_PRIMARY = 1;
}

enum WeaponPhase {
  WEAPON_PHASE_UNSPECIFIED = 0;
  WEAPON_PHASE_IDLE = 1;
}
