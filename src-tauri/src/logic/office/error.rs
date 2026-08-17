use std::fmt;

#[derive(Debug)]
pub struct OfficeToolError(pub String);

impl fmt::Display for OfficeToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OfficeToolError {}

pub fn oerr<E: fmt::Display>(e: E) -> OfficeToolError {
    OfficeToolError(e.to_string())
}
