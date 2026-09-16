//! Compatibility shim — implementation lives in `crates/toolsets/analytics-tools` (kawai-analytics crate).

pub use kawai_analytics::*;

/// Fire-and-forget eager conversion of an uploaded xlsx/xlsm to cached
/// parquet sidecars (one per data-bearing sheet). Upload = analysis intent,
/// so conversion happens here instead of on the first data tool call.
/// Best-effort: never fails the import, never blocks the caller; per-sheet
/// errors are logged and `open` re-tries lazily on real use.
pub fn prewarm_tabular(user_id: &str, file: &kawai_office::store::OfficeFile) {
    if !matches!(file.ext.as_str(), "xlsx" | "xlsm") {
        return;
    }
    let user = user_id.to_string();
    let id = file.id.clone();
    let name = file.original_name.clone();
    std::thread::spawn(move || {
        let Ok((path, _)) = kawai_office::store::resolve(&user, &id) else {
            return;
        };
        let n = ::analytics::prewarm_workbook(&path);
        if n > 0 {
            eprintln!("[analytics] prewarmed {n} sheet(s) of {name:?}");
        }
    });
}
