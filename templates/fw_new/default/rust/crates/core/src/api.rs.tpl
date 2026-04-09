use crate::bridge::event::GameEvent;
use crate::bridge::{EntitySnapshot, WorldSnapshot};
use fw::Vec2i;

pub struct Game {
    tick: u32,
    events: Vec<GameEvent>,
}

impl Game {
    pub fn new() -> Self {
        Self {
            tick: 0,
            events: vec![GameEvent::Started {
                message: "game started".to_owned(),
            }],
        }
    }

    pub fn tick(&mut self) {
        self.tick += 1;
        self.events.clear();
    }

    pub fn snapshot(&self) -> WorldSnapshot {
        WorldSnapshot {
            tick: self.tick,
            entities: vec![EntitySnapshot {
                id: 1,
                label: "sample".to_owned(),
                pos: Vec2i::new(0, 0),
            }],
        }
    }

    pub fn events(&self) -> &[GameEvent] {
        &self.events
    }
}
