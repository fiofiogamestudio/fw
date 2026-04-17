use crate::sync::peer::{PeerSyncState, PeerValueState};
use std::collections::{HashMap, HashSet};
use std::hash::Hash;

#[derive(Clone, PartialEq, Debug, Default)]
pub struct SyncKeyDelta<K> {
    pub entered: Vec<K>,
    pub updated: Vec<K>,
    pub left: Vec<K>,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct SyncValueDelta<K, V> {
    pub entered: Vec<V>,
    pub updated: Vec<V>,
    pub left: Vec<K>,
}

pub fn build_key_delta<K>(
    peer: &PeerSyncState<K>,
    current_revisions: &HashMap<K, u32>,
) -> SyncKeyDelta<K>
where
    K: Eq + Hash + Clone,
{
    let mut entered = Vec::new();
    let mut updated = Vec::new();
    let mut current_keys: HashSet<K> = HashSet::new();

    for (key, revision) in current_revisions {
        current_keys.insert(key.clone());
        match peer.revision_for(key) {
            None => entered.push(key.clone()),
            Some(previous) if previous != *revision => updated.push(key.clone()),
            _ => {}
        }
    }

    let mut left = Vec::new();
    for key in peer.keys() {
        if !current_keys.contains(key) {
            left.push(key.clone());
        }
    }

    SyncKeyDelta {
        entered,
        updated,
        left,
    }
}

pub fn build_value_delta<K, V>(
    peer: &PeerValueState<K, V>,
    current_values: &HashMap<K, V>,
) -> SyncValueDelta<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone + PartialEq,
{
    let mut entered = Vec::new();
    let mut updated = Vec::new();
    let mut current_keys: HashSet<K> = HashSet::new();

    for (key, value) in current_values {
        current_keys.insert(key.clone());
        match peer.value_for(key) {
            None => entered.push(value.clone()),
            Some(previous) if previous != value => updated.push(value.clone()),
            _ => {}
        }
    }

    let mut left = Vec::new();
    for key in peer.keys() {
        if !current_keys.contains(key) {
            left.push(key.clone());
        }
    }

    SyncValueDelta {
        entered,
        updated,
        left,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_key_delta_splits_enter_update_leave() {
        let mut peer = PeerSyncState::default();
        peer.mark_seen("a", 1);
        peer.mark_seen("b", 2);

        let current = HashMap::from([("b", 3), ("c", 1)]);

        let delta = build_key_delta(&peer, &current);

        assert_eq!(delta.entered, vec!["c"]);
        assert_eq!(delta.updated, vec!["b"]);
        assert_eq!(delta.left, vec!["a"]);
    }

    #[test]
    fn build_value_delta_splits_enter_update_leave() {
        let mut peer = PeerValueState::default();
        peer.mark_seen("a", 1);
        peer.mark_seen("b", 2);

        let current = HashMap::from([("b", 3), ("c", 1)]);

        let delta = build_value_delta(&peer, &current);

        assert_eq!(delta.entered, vec![1]);
        assert_eq!(delta.updated, vec![3]);
        assert_eq!(delta.left, vec!["a"]);
    }
}
