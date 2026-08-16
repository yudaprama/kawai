//! Re-exports every generated tool type.

#[path = "hacker_news.gen.rs"]
pub mod hacker_news;
pub use hacker_news::*;
#[path = "newsapi.gen.rs"]
pub mod newsapi;
pub use newsapi::*;
