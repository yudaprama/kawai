//! Smoke test: verify generated tools implement PortableTool and the registry
//! works. Run with `cargo run --example smoke`.

use rig::tool::PortableTool;
use weather_geo::generated::{GetWeatherForecastTool, GetWeatherTool};

fn main() {
    let t = GetWeatherTool::default();
    assert_eq!(GetWeatherTool::NAME, "get_weather");
    assert!(t.description().contains("weather"));
    let params = t.parameters();
    assert_eq!(params["properties"]["location"]["type"], "string");

    let f = GetWeatherForecastTool::default();
    assert_eq!(f.parameters()["properties"]["days"]["type"], "integer");

    assert!(weather_geo::is_native("get_weather"));
    assert!(!weather_geo::is_native("nope"));
    assert_eq!(weather_geo::native_names().len(), 7);

    let _set = weather_geo::all_tools();
    let _subset = weather_geo::toolset_for(&["get_weather", "geocode"]);

    println!("name: {}", GetWeatherTool::NAME);
    println!("params: {params}");
    println!("SMOKE OK — 7 tools, registry + PortableTool verified");
}
