//! Golden contract fixture — shared by every generated-tools registry test.
//!
//! Locks each tool's model-facing contract (name, description, parameters,
//! confirmation flag, produces) to `<crate>/tests/golden_tools.json`.
//! Regenerate after an INTENTIONAL contract change with
//! `UPDATE_GOLDEN=1 cargo test -p <crate>`; any other diff is a regression.

use crate::ToolSet;

/// Assert that `<manifest_dir>/tests/golden_tools.json` matches `set`'s tool
/// definitions sorted by name. Each registry crate calls this from its own
/// `#[cfg(test)] mod golden_contracts` — one shared body, no per-crate copy.
pub fn assert_golden_contracts(set: &ToolSet, manifest_dir: &str) {
    let mut defs = set.get_tool_definitions().to_vec();
    defs.sort_by(|a, b| a.name.cmp(&b.name));
    let current: Vec<serde_json::Value> = defs
        .iter()
        .map(|d| {
            serde_json::json!({
                "name": d.name,
                "description": d.description,
                "parameters": d.parameters,
                "requiresConfirmation": d.requires_confirmation,
                "produces": d.produces,
            })
        })
        .collect();
    let current = serde_json::to_string_pretty(&current).unwrap() + "\n";
    let path = std::path::Path::new(manifest_dir).join("tests/golden_tools.json");
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &current).unwrap();
    }
    let golden = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "missing golden fixture {} ({e}) — run UPDATE_GOLDEN=1 cargo test",
            path.display()
        )
    });
    assert_eq!(
        current, golden,
        "tool contract drifted from the golden fixture"
    );
}
