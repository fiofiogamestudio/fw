pub trait System<C> {
    fn init(&mut self, _context: &mut C) {}
    fn tick(&mut self, context: &mut C, dt: f32);
    fn shutdown(&mut self, _context: &mut C) {}
}
