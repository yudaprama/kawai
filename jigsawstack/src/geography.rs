//! Geography search and geocoding.

use reqwest::Method;
use serde::Deserialize;

use crate::request::Querier;
use crate::{JigsawStack, Result};

/// Endpoint for the geography API.
pub const GEOGRAPHY_ENDPOINT: &str = "/v1/geo/search";

/// Request structure for the geography API. Fields are only sent when set.
#[derive(Debug, Clone, Default)]
pub struct GeographyRequest {
    /// The query string to search for.
    pub query: String,
    /// The country to search within.
    pub country: String,
    /// The latitude of the search center.
    pub latitude: f64,
    /// The latitude of the proximity center.
    pub proximity_lat: f64,
    /// The longitude of the search center.
    pub longitude: f64,
    /// The longitude of the proximity center.
    pub proximity_lng: f64,
    /// The types of places to include.
    pub types: String,
}

impl Querier for GeographyRequest {
    fn url_query(&self, out: &mut Vec<(String, String)>) {
        if !self.query.is_empty() {
            out.push(("query".to_string(), self.query.clone()));
        }
        if !self.country.is_empty() {
            out.push(("country".to_string(), self.country.clone()));
        }
        if self.latitude != 0.0 {
            out.push(("latitude".to_string(), self.latitude.to_string()));
        }
        if self.proximity_lat != 0.0 {
            out.push(("proximity_lat".to_string(), self.proximity_lat.to_string()));
        }
        if self.longitude != 0.0 {
            out.push(("longitude".to_string(), self.longitude.to_string()));
        }
        if self.proximity_lng != 0.0 {
            out.push(("proximity_lng".to_string(), self.proximity_lng.to_string()));
        }
        if !self.types.is_empty() {
            out.push(("types".to_string(), self.types.clone()));
        }
    }
}

/// Region metadata for a geography result.
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyRegion {
    /// The region name.
    pub name: String,
    /// The region code.
    pub region_code: String,
    /// The full region code.
    pub region_code_full: String,
}

/// Country metadata for a geography result.
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyCountry {
    /// The country name.
    pub name: String,
    /// The two-letter country code.
    pub country_code: String,
    /// The three-letter country code.
    pub country_code_alpha_3: String,
}

/// Geolocation data for a geography result.
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyGeoloc {
    /// The geometry type (e.g. "Point").
    pub r#type: String,
    /// The coordinates as `[longitude, latitude]`.
    #[serde(default)]
    pub coordinates: Vec<f64>,
}

/// Open-hours data for a geography result (opaque).
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyOpenHours {}

/// Additional properties for a geography result.
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyAdditionalProperties {
    /// The phone number.
    #[serde(default)]
    pub phone: String,
    /// The website URL.
    #[serde(default)]
    pub website: String,
    /// The open-hours data.
    pub open_hours: Option<GeographyOpenHours>,
}

/// A single geography result.
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyData {
    /// The type of the place.
    pub r#type: String,
    /// The full address.
    pub full_address: String,
    /// The name of the place.
    pub name: String,
    /// The formatted place string.
    pub place_formatted: String,
    /// The postcode.
    pub postcode: String,
    /// The place name.
    pub place: String,
    /// The region.
    pub region: GeographyRegion,
    /// The country.
    pub country: GeographyCountry,
    /// The language.
    pub language: String,
    /// The geolocation.
    pub geoloc: GeographyGeoloc,
    /// The POI categories.
    #[serde(default)]
    pub poi_category: Vec<String>,
    /// Additional properties.
    #[serde(default)]
    pub additional_properties: Option<GeographyAdditionalProperties>,
}

/// Response structure for the geography API.
#[derive(Debug, Clone, Deserialize)]
pub struct GeographyResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The matching places.
    #[serde(default)]
    pub data: Vec<GeographyData>,
}

impl JigsawStack {
    async fn geography(
        &self,
        method: Method,
        request: &GeographyRequest,
    ) -> Result<GeographyResponse> {
        self.send_json(method, GEOGRAPHY_ENDPOINT, None, Some(request))
            .await
    }

    /// Performs a geography search call over a query string.
    ///
    /// POST https://api.jigsawstack.com/v1/geo/search
    pub async fn geography_search(
        &self,
        request: &GeographyRequest,
    ) -> Result<GeographyResponse> {
        self.geography(Method::POST, request).await
    }

    /// Performs a geography geocode call over a query string.
    ///
    /// GET https://api.jigsawstack.com/v1/geo/search
    pub async fn geography_geocode(
        &self,
        request: &GeographyRequest,
    ) -> Result<GeographyResponse> {
        self.geography(Method::GET, request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_query_only_sets_non_defaults() {
        let req = GeographyRequest {
            query: "tokyo".into(),
            latitude: 35.6762,
            ..Default::default()
        };
        let mut out = Vec::new();
        req.url_query(&mut out);
        let map: std::collections::HashMap<String, String> = out.into_iter().collect();
        assert_eq!(map.len(), 2);
        assert_eq!(map["query"], "tokyo");
        assert_eq!(map["latitude"], "35.6762");
    }

    #[test]
    fn url_query_empty() {
        let req = GeographyRequest::default();
        let mut out = Vec::new();
        req.url_query(&mut out);
        assert!(out.is_empty());
    }
}
