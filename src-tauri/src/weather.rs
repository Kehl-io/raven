use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_LOCATION: &str = "Denver, CO";
const DEFAULT_LATITUDE: f64 = 39.7392;
const DEFAULT_LONGITUDE: f64 = -104.9903;
const DEFAULT_HOURS: usize = 24;
const MAX_HOURS: usize = 168;

#[derive(Debug, thiserror::Error)]
pub enum WeatherError {
    #[error("weather api failed: {0}")]
    Api(String),
    #[error("invalid weather input: {0}")]
    InvalidInput(String),
    #[error("invalid weather payload: {0}")]
    InvalidPayload(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemperatureUnits {
    Fahrenheit,
    Celsius,
}

impl Default for TemperatureUnits {
    fn default() -> Self {
        Self::Fahrenheit
    }
}

impl TemperatureUnits {
    fn temperature_unit_param(self) -> &'static str {
        match self {
            Self::Fahrenheit => "fahrenheit",
            Self::Celsius => "celsius",
        }
    }

    fn wind_speed_unit_param(self) -> &'static str {
        match self {
            Self::Fahrenheit => "mph",
            Self::Celsius => "kmh",
        }
    }

    fn precipitation_unit_param(self) -> &'static str {
        match self {
            Self::Fahrenheit => "inch",
            Self::Celsius => "mm",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeatherForecastRequest {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub location: Option<String>,
    pub units: Option<TemperatureUnits>,
    pub hours: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedWeatherRequest {
    pub latitude: f64,
    pub longitude: f64,
    pub location: String,
    pub units: TemperatureUnits,
    pub hours: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeatherForecastUnits {
    pub temperature: String,
    pub apparent_temperature: String,
    pub precipitation_probability: String,
    pub precipitation: String,
    pub wind_speed: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HourlyWeatherPeriod {
    pub time: String,
    pub temperature: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apparent_temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precipitation_probability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precipitation: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather_code: Option<i64>,
    pub condition: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeatherForecast {
    pub location: String,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub fetched_at: String,
    pub source_refs: Vec<String>,
    pub units: WeatherForecastUnits,
    pub hourly: Vec<HourlyWeatherPeriod>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeatherAlertsRequest {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub location: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeatherAlerts {
    pub location: String,
    pub latitude: f64,
    pub longitude: f64,
    pub fetched_at: String,
    pub source_refs: Vec<String>,
    pub status: String,
    pub detail: String,
    pub alerts: Vec<Value>,
}

impl WeatherForecastRequest {
    pub fn resolved(&self) -> Result<ResolvedWeatherRequest, WeatherError> {
        let (latitude, longitude) = resolve_coordinates(self.latitude, self.longitude)?;
        Ok(ResolvedWeatherRequest {
            latitude,
            longitude,
            location: self
                .location
                .as_deref()
                .filter(|location| !location.trim().is_empty())
                .unwrap_or(DEFAULT_LOCATION)
                .to_string(),
            units: self.units.unwrap_or_default(),
            hours: clamp_hours(self.hours.unwrap_or(DEFAULT_HOURS)),
        })
    }
}

impl WeatherAlertsRequest {
    pub fn resolved(&self) -> Result<ResolvedWeatherRequest, WeatherError> {
        let (latitude, longitude) = resolve_coordinates(self.latitude, self.longitude)?;
        Ok(ResolvedWeatherRequest {
            latitude,
            longitude,
            location: self
                .location
                .as_deref()
                .filter(|location| !location.trim().is_empty())
                .unwrap_or(DEFAULT_LOCATION)
                .to_string(),
            units: TemperatureUnits::default(),
            hours: DEFAULT_HOURS,
        })
    }
}

pub fn hourly_forecast(request: WeatherForecastRequest) -> Result<WeatherForecast, WeatherError> {
    let resolved = request.resolved()?;
    let response: Value = ureq::get(&open_meteo_forecast_url(&resolved))
        .call()
        .map_err(|error| WeatherError::Api(error.to_string()))?
        .into_json()
        .map_err(|error| WeatherError::Api(error.to_string()))?;
    hourly_forecast_from_json(&resolved, &response, Utc::now().to_rfc3339())
}

pub fn hourly_forecast_json(input: Value) -> Result<Value, WeatherError> {
    let request: WeatherForecastRequest = serde_json::from_value(input)
        .map_err(|error| WeatherError::InvalidInput(error.to_string()))?;
    serde_json::to_value(hourly_forecast(request)?)
        .map_err(|error| WeatherError::InvalidPayload(error.to_string()))
}

pub fn forecast_24h(mut request: WeatherForecastRequest) -> Result<WeatherForecast, WeatherError> {
    request.hours = Some(DEFAULT_HOURS);
    hourly_forecast(request)
}

pub fn forecast_24h_json(input: Value) -> Result<Value, WeatherError> {
    let request: WeatherForecastRequest = serde_json::from_value(input)
        .map_err(|error| WeatherError::InvalidInput(error.to_string()))?;
    serde_json::to_value(forecast_24h(request)?)
        .map_err(|error| WeatherError::InvalidPayload(error.to_string()))
}

pub fn alerts(request: WeatherAlertsRequest) -> Result<WeatherAlerts, WeatherError> {
    alerts_at(request, Utc::now().to_rfc3339())
}

pub fn alerts_json(input: Value) -> Result<Value, WeatherError> {
    let request: WeatherAlertsRequest = serde_json::from_value(input)
        .map_err(|error| WeatherError::InvalidInput(error.to_string()))?;
    serde_json::to_value(alerts(request)?)
        .map_err(|error| WeatherError::InvalidPayload(error.to_string()))
}

pub fn hourly_forecast_from_json(
    request: &ResolvedWeatherRequest,
    value: &Value,
    fetched_at: String,
) -> Result<WeatherForecast, WeatherError> {
    let hourly = value
        .get("hourly")
        .and_then(Value::as_object)
        .ok_or_else(|| WeatherError::InvalidPayload("missing hourly forecast payload".into()))?;
    let hourly_units = value
        .get("hourly_units")
        .and_then(Value::as_object)
        .ok_or_else(|| WeatherError::InvalidPayload("missing hourly forecast units".into()))?;
    let times = hourly_array(hourly, "time")
        .ok_or_else(|| WeatherError::InvalidPayload("missing hourly time".into()))?;
    let temperatures = hourly_array(hourly, "temperature_2m")
        .ok_or_else(|| WeatherError::InvalidPayload("missing hourly temperature_2m".into()))?;
    let apparent_temperatures = hourly_array(hourly, "apparent_temperature");
    let precipitation_probabilities = hourly_array(hourly, "precipitation_probability");
    let precipitations = hourly_array(hourly, "precipitation");
    let wind_speeds = hourly_array(hourly, "wind_speed_10m");
    let weather_codes = hourly_array(hourly, "weather_code");
    let period_count = request.hours.min(times.len()).min(temperatures.len());

    let hourly = (0..period_count)
        .map(|index| {
            let time = times[index]
                .as_str()
                .ok_or_else(|| WeatherError::InvalidPayload("hourly time must be a string".into()))?
                .to_string();
            let temperature = temperatures[index].as_f64().ok_or_else(|| {
                WeatherError::InvalidPayload("hourly temperature_2m must be numeric".into())
            })?;
            let weather_code = optional_i64(weather_codes, index);

            Ok(HourlyWeatherPeriod {
                time,
                temperature,
                apparent_temperature: optional_f64(apparent_temperatures, index),
                precipitation_probability: optional_f64(precipitation_probabilities, index),
                precipitation: optional_f64(precipitations, index),
                wind_speed: optional_f64(wind_speeds, index),
                weather_code,
                condition: weather_code
                    .map(crate::providers::weather_condition)
                    .unwrap_or("Unknown conditions")
                    .to_string(),
            })
        })
        .collect::<Result<Vec<_>, WeatherError>>()?;

    Ok(WeatherForecast {
        location: request.location.clone(),
        latitude: value
            .get("latitude")
            .and_then(Value::as_f64)
            .unwrap_or(request.latitude),
        longitude: value
            .get("longitude")
            .and_then(Value::as_f64)
            .unwrap_or(request.longitude),
        timezone: value
            .get("timezone")
            .and_then(Value::as_str)
            .map(str::to_string),
        fetched_at,
        source_refs: vec![format!(
            "open-meteo:forecast:{},{}",
            request.latitude, request.longitude
        )],
        units: WeatherForecastUnits {
            temperature: unit(hourly_units, "temperature_2m"),
            apparent_temperature: unit(hourly_units, "apparent_temperature"),
            precipitation_probability: unit(hourly_units, "precipitation_probability"),
            precipitation: unit(hourly_units, "precipitation"),
            wind_speed: unit(hourly_units, "wind_speed_10m"),
        },
        hourly,
    })
}

pub fn forecast_24h_from_json(
    request: &WeatherForecastRequest,
    value: &Value,
    fetched_at: String,
) -> Result<WeatherForecast, WeatherError> {
    let mut resolved = request.resolved()?;
    resolved.hours = DEFAULT_HOURS;
    hourly_forecast_from_json(&resolved, value, fetched_at)
}

pub fn alerts_at(
    request: WeatherAlertsRequest,
    fetched_at: String,
) -> Result<WeatherAlerts, WeatherError> {
    let resolved = request.resolved()?;
    Ok(WeatherAlerts {
        location: resolved.location,
        latitude: resolved.latitude,
        longitude: resolved.longitude,
        fetched_at,
        source_refs: vec!["weather.alerts:deterministic-no-global-source".into()],
        status: "unsupported".into(),
        detail: "No deterministic no-key global alerts source is configured; returning an empty alerts list instead of failing.".into(),
        alerts: Vec::new(),
    })
}

pub fn open_meteo_forecast_url(request: &ResolvedWeatherRequest) -> String {
    format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,weather_code&temperature_unit={}&wind_speed_unit={}&precipitation_unit={}&timezone=auto&forecast_hours={}",
        request.latitude,
        request.longitude,
        request.units.temperature_unit_param(),
        request.units.wind_speed_unit_param(),
        request.units.precipitation_unit_param(),
        request.hours
    )
}

fn resolve_coordinates(
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(f64, f64), WeatherError> {
    match (latitude, longitude) {
        (Some(latitude), Some(longitude)) => {
            if !(-90.0..=90.0).contains(&latitude) {
                return Err(WeatherError::InvalidInput(
                    "latitude must be between -90 and 90".into(),
                ));
            }
            if !(-180.0..=180.0).contains(&longitude) {
                return Err(WeatherError::InvalidInput(
                    "longitude must be between -180 and 180".into(),
                ));
            }
            Ok((latitude, longitude))
        }
        (None, None) => Ok((DEFAULT_LATITUDE, DEFAULT_LONGITUDE)),
        _ => Err(WeatherError::InvalidInput(
            "latitude and longitude must be provided together".into(),
        )),
    }
}

fn clamp_hours(hours: usize) -> usize {
    hours.clamp(1, MAX_HOURS)
}

fn hourly_array<'a>(
    hourly: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a Vec<Value>> {
    hourly.get(key).and_then(Value::as_array)
}

fn optional_f64(values: Option<&Vec<Value>>, index: usize) -> Option<f64> {
    values
        .and_then(|values| values.get(index))
        .and_then(Value::as_f64)
}

fn optional_i64(values: Option<&Vec<Value>>, index: usize) -> Option<i64> {
    values
        .and_then(|values| values.get(index))
        .and_then(Value::as_i64)
}

fn unit(units: &serde_json::Map<String, Value>, key: &str) -> String {
    units
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_defaults_to_denver_and_clamps_hours() {
        let default_request = WeatherForecastRequest::default().resolved().unwrap();

        assert_eq!(default_request.location, "Denver, CO");
        assert_eq!(default_request.latitude, 39.7392);
        assert_eq!(default_request.longitude, -104.9903);
        assert_eq!(default_request.units, TemperatureUnits::Fahrenheit);
        assert_eq!(default_request.hours, 24);

        let clamped_high = WeatherForecastRequest {
            hours: Some(500),
            ..WeatherForecastRequest::default()
        }
        .resolved()
        .unwrap();
        assert_eq!(clamped_high.hours, 168);

        let clamped_low = WeatherForecastRequest {
            hours: Some(0),
            ..WeatherForecastRequest::default()
        }
        .resolved()
        .unwrap();
        assert_eq!(clamped_low.hours, 1);
    }

    #[test]
    fn request_requires_coordinate_pairs() {
        let error = WeatherForecastRequest {
            latitude: Some(39.7392),
            ..WeatherForecastRequest::default()
        }
        .resolved()
        .unwrap_err();

        assert!(error.to_string().contains("provided together"));
    }

    #[test]
    fn hourly_forecast_from_json_parses_open_meteo_fixture() {
        let payload = json!({
            "latitude": 39.75,
            "longitude": -105.0,
            "timezone": "America/Denver",
            "hourly_units": {
                "time": "iso8601",
                "temperature_2m": "F",
                "apparent_temperature": "F",
                "precipitation_probability": "%",
                "precipitation": "inch",
                "wind_speed_10m": "mph",
                "weather_code": "wmo code"
            },
            "hourly": {
                "time": ["2026-06-21T09:00", "2026-06-21T10:00", "2026-06-21T11:00"],
                "temperature_2m": [72.1, 74.0, 77.5],
                "apparent_temperature": [70.8, 72.2, 75.6],
                "precipitation_probability": [0, 10, 25],
                "precipitation": [0.0, 0.0, 0.02],
                "wind_speed_10m": [5.2, 8.0, 11.3],
                "weather_code": [1, 2, 61]
            }
        });
        let request = WeatherForecastRequest {
            latitude: Some(39.7392),
            longitude: Some(-104.9903),
            location: Some("Denver metro".into()),
            units: Some(TemperatureUnits::Fahrenheit),
            hours: Some(2),
        }
        .resolved()
        .unwrap();

        let forecast =
            hourly_forecast_from_json(&request, &payload, "2026-06-21T15:00:00Z".into()).unwrap();

        assert_eq!(forecast.location, "Denver metro");
        assert_eq!(forecast.latitude, 39.75);
        assert_eq!(forecast.longitude, -105.0);
        assert_eq!(forecast.timezone, Some("America/Denver".into()));
        assert_eq!(forecast.fetched_at, "2026-06-21T15:00:00Z");
        assert_eq!(
            forecast.source_refs,
            vec!["open-meteo:forecast:39.7392,-104.9903"]
        );
        assert_eq!(forecast.units.temperature, "F");
        assert_eq!(forecast.units.precipitation_probability, "%");
        assert_eq!(forecast.hourly.len(), 2);
        assert_eq!(forecast.hourly[0].time, "2026-06-21T09:00");
        assert_eq!(forecast.hourly[0].temperature, 72.1);
        assert_eq!(forecast.hourly[0].weather_code, Some(1));
        assert_eq!(forecast.hourly[0].condition, "Mainly clear");
        assert_eq!(forecast.hourly[1].precipitation_probability, Some(10.0));
        assert_eq!(forecast.hourly[1].condition, "Partly cloudy");
    }

    #[test]
    fn forecast_24h_from_json_overrides_request_hours() {
        let payload = json!({
            "latitude": 39.7392,
            "longitude": -104.9903,
            "hourly_units": {
                "temperature_2m": "F",
                "apparent_temperature": "F",
                "precipitation_probability": "%",
                "precipitation": "inch",
                "wind_speed_10m": "mph"
            },
            "hourly": {
                "time": (0..30).map(|hour| format!("2026-06-21T{hour:02}:00")).collect::<Vec<_>>(),
                "temperature_2m": vec![70.0; 30],
                "weather_code": vec![0; 30]
            }
        });
        let request = WeatherForecastRequest {
            hours: Some(3),
            ..WeatherForecastRequest::default()
        };

        let forecast =
            forecast_24h_from_json(&request, &payload, "2026-06-21T15:00:00Z".into()).unwrap();

        assert_eq!(forecast.hourly.len(), 24);
        assert!(forecast
            .hourly
            .iter()
            .all(|period| period.condition == "Clear sky"));
    }

    #[test]
    fn alerts_returns_structured_empty_unsupported_result() {
        let alerts = alerts_at(
            WeatherAlertsRequest {
                location: Some("Denver, CO".into()),
                latitude: None,
                longitude: None,
            },
            "2026-06-21T15:00:00Z".into(),
        )
        .unwrap();

        assert_eq!(alerts.location, "Denver, CO");
        assert_eq!(alerts.latitude, 39.7392);
        assert_eq!(alerts.longitude, -104.9903);
        assert_eq!(alerts.status, "unsupported");
        assert!(alerts.detail.contains("empty alerts list"));
        assert!(alerts.alerts.is_empty());
        assert_eq!(
            alerts.source_refs,
            vec!["weather.alerts:deterministic-no-global-source"]
        );
    }

    #[test]
    fn open_meteo_url_uses_requested_units_and_hours() {
        let request = WeatherForecastRequest {
            latitude: Some(51.5),
            longitude: Some(-0.12),
            units: Some(TemperatureUnits::Celsius),
            hours: Some(12),
            ..WeatherForecastRequest::default()
        }
        .resolved()
        .unwrap();

        let url = open_meteo_forecast_url(&request);

        assert!(url.contains("latitude=51.5"));
        assert!(url.contains("longitude=-0.12"));
        assert!(url.contains("temperature_unit=celsius"));
        assert!(url.contains("wind_speed_unit=kmh"));
        assert!(url.contains("precipitation_unit=mm"));
        assert!(url.contains("forecast_hours=12"));
    }
}
