use godot::builtin::{VarArray, VarDictionary};
use godot::prelude::*;

use core::api::Game;

#[path = "../_gen/mod.rs"]
mod _gen;

struct GameBridgeLib;

#[gdextension]
unsafe impl ExtensionLibrary for GameBridgeLib {}

#[derive(GodotClass)]
#[class(base=RefCounted)]
pub struct GameBridge {
    base: Base<RefCounted>,
    game: Option<Game>,
}

#[godot_api]
impl IRefCounted for GameBridge {
    fn init(base: Base<RefCounted>) -> Self {
        Self { base, game: None }
    }
}

#[godot_api]
impl GameBridge {
    #[func]
    pub fn start(&mut self) {
        self.game = Some(Game::new());
    }

    #[func]
    pub fn tick(&mut self) {
        if let Some(game) = &mut self.game {
            game.tick();
        }
    }

    #[func]
    pub fn get_snapshot(&self) -> VarDictionary {
        let Some(game) = &self.game else {
            return VarDictionary::new();
        };
        _gen::_snapshot::encode_world_snapshot(&game.snapshot())
    }

    #[func]
    pub fn get_events(&self) -> VarArray {
        let Some(game) = &self.game else {
            return VarArray::new();
        };
        _gen::_event::encode_all(game.events())
    }
}
