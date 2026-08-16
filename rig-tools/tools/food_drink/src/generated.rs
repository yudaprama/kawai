//! Re-exports every generated tool type.

#[path = "thecocktaildb.gen.rs"]
pub mod thecocktaildb;
pub use thecocktaildb::*;
#[path = "themealdb.gen.rs"]
pub mod themealdb;
pub use themealdb::*;
#[path = "world.gen.rs"]
pub mod world;
pub use world::*;
