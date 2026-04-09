use std::collections::HashMap;
use std::hash::Hash;

type EnterHook<C> = Box<dyn FnMut(&mut C)>;
type ExitHook<C> = Box<dyn FnMut(&mut C)>;
type TickHook<C> = Box<dyn FnMut(&mut C, f32)>;
type TransitionHook<C> = Box<dyn FnMut(&mut C)>;

pub struct Fsm<S, C>
where
    S: Copy + Eq + Hash,
{
    active: bool,
    current: Option<S>,
    enter: HashMap<S, EnterHook<C>>,
    exit: HashMap<S, ExitHook<C>>,
    tick: HashMap<S, TickHook<C>>,
    transitions: HashMap<(S, S), TransitionHook<C>>,
}

impl<S, C> Default for Fsm<S, C>
where
    S: Copy + Eq + Hash,
{
    fn default() -> Self {
        Self {
            active: false,
            current: None,
            enter: HashMap::new(),
            exit: HashMap::new(),
            tick: HashMap::new(),
            transitions: HashMap::new(),
        }
    }
}

impl<S, C> Fsm<S, C>
where
    S: Copy + Eq + Hash,
{
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_enter<F>(&mut self, state: S, callback: F)
    where
        F: FnMut(&mut C) + 'static,
    {
        self.enter.insert(state, Box::new(callback));
    }

    pub fn register_exit<F>(&mut self, state: S, callback: F)
    where
        F: FnMut(&mut C) + 'static,
    {
        self.exit.insert(state, Box::new(callback));
    }

    pub fn register_tick<F>(&mut self, state: S, callback: F)
    where
        F: FnMut(&mut C, f32) + 'static,
    {
        self.tick.insert(state, Box::new(callback));
    }

    pub fn register_transition<F>(&mut self, from: S, to: S, callback: F)
    where
        F: FnMut(&mut C) + 'static,
    {
        self.transitions.insert((from, to), Box::new(callback));
    }

    pub fn start(&mut self, context: &mut C, state: S) {
        if self.active {
            return;
        }
        self.active = true;
        self.current = Some(state);
        if let Some(enter) = self.enter.get_mut(&state) {
            enter(context);
        }
    }

    pub fn stop(&mut self, context: &mut C) {
        if !self.active {
            return;
        }
        if let Some(current) = self.current {
            if let Some(exit) = self.exit.get_mut(&current) {
                exit(context);
            }
        }
        self.active = false;
        self.current = None;
    }

    pub fn transition(&mut self, context: &mut C, target: S) -> bool {
        if !self.active {
            return false;
        }
        let Some(current) = self.current else {
            return false;
        };
        if let Some(exit) = self.exit.get_mut(&current) {
            exit(context);
        }
        if let Some(transition) = self.transitions.get_mut(&(current, target)) {
            transition(context);
        }
        self.current = Some(target);
        if let Some(enter) = self.enter.get_mut(&target) {
            enter(context);
        }
        true
    }

    pub fn tick(&mut self, context: &mut C, dt: f32) {
        if !self.active {
            return;
        }
        if let Some(current) = self.current {
            if let Some(tick) = self.tick.get_mut(&current) {
                tick(context, dt);
            }
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn current(&self) -> Option<S> {
        self.current
    }
}
