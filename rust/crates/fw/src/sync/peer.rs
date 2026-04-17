use std::collections::HashMap;
use std::hash::Hash;

#[derive(Clone, PartialEq, Debug, Default)]
pub struct PeerSyncState<K>
where
    K: Eq + Hash,
{
    revisions: HashMap<K, u32>,
}

impl<K> PeerSyncState<K>
where
    K: Eq + Hash + Clone,
{
    pub fn revision_for(&self, key: &K) -> Option<u32> {
        self.revisions.get(key).copied()
    }

    pub fn mark_seen(&mut self, key: K, revision: u32) {
        self.revisions.insert(key, revision);
    }

    pub fn forget(&mut self, key: &K) -> bool {
        self.revisions.remove(key).is_some()
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.revisions.keys()
    }
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct PeerValueState<K, V>
where
    K: Eq + Hash,
{
    values: HashMap<K, V>,
}

impl<K, V> PeerValueState<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone,
{
    pub fn value_for(&self, key: &K) -> Option<&V> {
        self.values.get(key)
    }

    pub fn mark_seen(&mut self, key: K, value: V) {
        self.values.insert(key, value);
    }

    pub fn forget(&mut self, key: &K) -> bool {
        self.values.remove(key).is_some()
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.values.keys()
    }
}
