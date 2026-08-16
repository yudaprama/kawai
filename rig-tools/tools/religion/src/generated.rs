//! Re-exports every generated tool type.

#[path = "alquran.gen.rs"]
pub mod alquran;
pub use alquran::*;
#[path = "bible_api.gen.rs"]
pub mod bible_api;
pub use bible_api::*;
#[path = "wikimedia.gen.rs"]
pub mod wikimedia;
pub use wikimedia::*;
