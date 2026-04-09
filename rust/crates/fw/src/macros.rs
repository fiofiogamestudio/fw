#[macro_export]
macro_rules! def_id {
    ($name:ident($inner:ty)) => {
        #[derive(
            Clone, Copy, PartialEq, Eq, Hash, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        pub struct $name(pub $inner);
    };
}

#[macro_export]
macro_rules! def_val {
    ($name:ident { $($f:ident : $t:ty),+ $(,)? }) => {
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default, serde::Serialize, serde::Deserialize)]
        pub struct $name {
            $(pub $f: $t),+
        }
    };
}

#[macro_export]
macro_rules! def_obj {
    ($name:ident { $($f:ident : $t:ty),+ $(,)? }) => {
        #[derive(Clone, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
        pub struct $name {
            $(pub $f: $t),+
        }
    };
}

#[macro_export]
macro_rules! def_enum {
    ($name:ident { $first:ident $(, $rest:ident)* $(,)? }) => {
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $first,
            $($rest),*
        }
        impl Default for $name {
            fn default() -> Self { Self::$first }
        }
    };
}

#[macro_export]
macro_rules! def_event {
    ($name:ident { $($variant:ident { $($f:ident : $t:ty),* $(,)? }),+ $(,)? }) => {
        #[derive(Clone, Copy, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $($variant { $($f: $t),* }),+
        }
    };
}

#[macro_export]
macro_rules! def_action {
    ($name:ident { $($variant:ident { $($f:ident : $t:ty),* $(,)? }),+ $(,)? }) => {
        #[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        pub enum $name {
            $($variant { $($f: $t),* }),+
        }
    };
}
