//! Re-exports every generated tool type.

#[path = "ipwho.gen.rs"]
pub mod ipwho;
pub use ipwho::*;
#[path = "nominatim.gen.rs"]
pub mod nominatim;
pub use nominatim::*;
#[path = "open_meteo.gen.rs"]
pub mod open_meteo;
pub use open_meteo::*;
#[path = "sunrisesunset.gen.rs"]
pub mod sunrisesunset;
pub use sunrisesunset::*;
#[path = "timeapi.gen.rs"]
pub mod timeapi;
pub use timeapi::*;
#[path = "wheretheiss.gen.rs"]
pub mod wheretheiss;
pub use wheretheiss::*;
#[path = "wttr.gen.rs"]
pub mod wttr;
pub use wttr::*;
