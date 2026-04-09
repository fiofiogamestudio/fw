pub struct ObjectPool<T> {
    items: Vec<T>,
}

impl<T> Default for ObjectPool<T> {
    fn default() -> Self {
        Self { items: Vec::new() }
    }
}

impl<T> ObjectPool<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            items: Vec::with_capacity(capacity),
        }
    }

    pub fn acquire_with<F>(&mut self, factory: F) -> T
    where
        F: FnOnce() -> T,
    {
        self.items.pop().unwrap_or_else(factory)
    }

    pub fn recycle(&mut self, item: T) {
        self.items.push(item);
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn available(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}
