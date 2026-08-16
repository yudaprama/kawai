//! Generated rig.rs tool crate. Edit the category YAML and re-run
//! `cargo run -p rig-tools-gen -- --category <name>`; do not hand-edit
//! `*.gen.rs` or `registry.rs`.

pub mod generated;
pub mod httpclient;
pub mod registry;

pub use registry::{all_tools, is_native, native_names, toolset_for};
