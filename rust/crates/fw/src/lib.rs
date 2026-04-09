#![doc = "Reusable gameplay-agnostic runtime framework for Rust game projects"]

#[macro_use]
mod macros;

pub mod flow;
pub mod math;
pub mod prelude;
pub mod rt;

pub use flow::fsm::*;
pub use math::fixed::*;
pub use math::geom::*;
pub use math::vec2f::*;
pub use rt::event::*;
pub use rt::pool::*;
pub use rt::system::app::*;
pub use rt::system::system::*;
pub use serde;
pub use rt::time::*;
