use super::system::System;

trait AppEntry {
    fn init(&mut self);
    fn tick(&mut self, dt: f32);
    fn shutdown(&mut self);
}

struct MountedSystem<S, C> {
    system: S,
    context: C,
    initialized: bool,
}

impl<S, C> MountedSystem<S, C> {
    fn new(system: S, context: C) -> Self {
        Self {
            system,
            context,
            initialized: false,
        }
    }
}

impl<S, C> AppEntry for MountedSystem<S, C>
where
    S: System<C> + 'static,
    C: 'static,
{
    fn init(&mut self) {
        if self.initialized {
            return;
        }
        self.system.init(&mut self.context);
        self.initialized = true;
    }

    fn tick(&mut self, dt: f32) {
        if !self.initialized {
            self.init();
        }
        self.system.tick(&mut self.context, dt);
    }

    fn shutdown(&mut self) {
        if !self.initialized {
            return;
        }
        self.system.shutdown(&mut self.context);
        self.initialized = false;
    }
}

#[derive(Default)]
pub struct App {
    entries: Vec<Box<dyn AppEntry>>,
}

impl App {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_system<S, C>(&mut self, system: S, context: C)
    where
        S: System<C> + 'static,
        C: 'static,
    {
        self.entries
            .push(Box::new(MountedSystem::new(system, context)));
    }

    pub fn init_all(&mut self) {
        for entry in &mut self.entries {
            entry.init();
        }
    }

    pub fn tick(&mut self, dt: f32) {
        for entry in &mut self.entries {
            entry.tick(dt);
        }
    }

    pub fn shutdown_all(&mut self) {
        for entry in self.entries.iter_mut().rev() {
            entry.shutdown();
        }
        self.entries.clear();
    }
}
