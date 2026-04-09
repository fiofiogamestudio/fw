use std::collections::BTreeMap;

pub type ListenerId = u64;

pub struct EventBus<E> {
    next_id: ListenerId,
    listeners: BTreeMap<ListenerId, Box<dyn FnMut(&E)>>,
}

impl<E> Default for EventBus<E> {
    fn default() -> Self {
        Self {
            next_id: 1,
            listeners: BTreeMap::new(),
        }
    }
}

impl<E> EventBus<E> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe<F>(&mut self, listener: F) -> ListenerId
    where
        F: FnMut(&E) + 'static,
    {
        let id = self.next_id;
        self.next_id += 1;
        self.listeners.insert(id, Box::new(listener));
        id
    }

    pub fn unsubscribe(&mut self, id: ListenerId) -> bool {
        self.listeners.remove(&id).is_some()
    }

    pub fn emit(&mut self, event: &E) {
        for listener in self.listeners.values_mut() {
            listener(event);
        }
    }

    pub fn clear(&mut self) {
        self.listeners.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.listeners.is_empty()
    }
}
