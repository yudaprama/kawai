//! Re-exports every generated tool type.

#[path = "chucknorris.gen.rs"]
pub mod chucknorris;
pub use chucknorris::*;
#[path = "deckofcardsapi.gen.rs"]
pub mod deckofcardsapi;
pub use deckofcardsapi::*;
#[path = "disify.gen.rs"]
pub mod disify;
pub use disify::*;
#[path = "opentdb.gen.rs"]
pub mod opentdb;
pub use opentdb::*;
#[path = "swapi.gen.rs"]
pub mod swapi;
pub use swapi::*;
#[path = "v2.gen.rs"]
pub mod v2;
pub use v2::*;
