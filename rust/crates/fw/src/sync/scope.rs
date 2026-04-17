#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum SyncScope<OwnerKey> {
    All,
    Own(OwnerKey),
    Aoi,
}
