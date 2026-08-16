//! Re-exports every generated tool type.

#[path = "date.gen.rs"]
pub mod date;
pub use date::*;
#[path = "dictionaryapi.gen.rs"]
pub mod dictionaryapi;
pub use dictionaryapi::*;
#[path = "fruityvice.gen.rs"]
pub mod fruityvice;
pub use fruityvice::*;
#[path = "github.gen.rs"]
pub mod github;
pub use github::*;
#[path = "mathjs.gen.rs"]
pub mod mathjs;
pub use mathjs::*;
#[path = "openalex.gen.rs"]
pub mod openalex;
pub use openalex::*;
#[path = "restcountries.gen.rs"]
pub mod restcountries;
pub use restcountries::*;
