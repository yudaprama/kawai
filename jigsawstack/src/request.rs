//! Request helpers shared across the API modules.

/// A trait for objects that can produce URL query parameters, mirroring the
/// Go client's `Querier` interface. Each pushed pair is rendered by reqwest
/// into a properly URL-encoded `?key=value` query string.
pub trait Querier {
    /// Appends `(key, value)` pairs to `out`.
    fn url_query(&self, out: &mut Vec<(String, String)>);
}
