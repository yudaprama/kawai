//! Re-exports every generated tool type.

#[path = "jikan.gen.rs"]
pub mod jikan;
pub use jikan::*;
#[path = "musicbrainz.gen.rs"]
pub mod musicbrainz;
pub use musicbrainz::*;
#[path = "openlibrary.gen.rs"]
pub mod openlibrary;
pub use openlibrary::*;
#[path = "pexels.gen.rs"]
pub mod pexels;
pub use pexels::*;
#[path = "poetrydb.gen.rs"]
pub mod poetrydb;
pub use poetrydb::*;
#[path = "tastedive.gen.rs"]
pub mod tastedive;
pub use tastedive::*;
#[path = "tvmaze.gen.rs"]
pub mod tvmaze;
pub use tvmaze::*;
