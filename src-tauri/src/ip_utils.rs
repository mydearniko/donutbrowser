//! IP address utilities shared across the application.
//!
//! Provides IP validation and public IP fetching functionality.

use std::net::IpAddr;
use std::str::FromStr;
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, StreamExt};

/// IP utility error type.
#[derive(Debug, thiserror::Error)]
pub enum IpError {
  #[error("Network error: {0}")]
  Network(String),
}

/// Validate an IP address (IPv4 or IPv6).
pub fn validate_ip(ip: &str) -> bool {
  IpAddr::from_str(ip).is_ok()
}

/// Fetch public IP address, optionally through a proxy.
pub async fn fetch_public_ip(proxy: Option<&str>) -> Result<String, IpError> {
  let urls = [
    "https://api.ipify.org",
    "https://checkip.amazonaws.com",
    "https://ipinfo.io/ip",
    "https://icanhazip.com",
    "https://ifconfig.co/ip",
    "https://ipecho.net/plain",
  ];

  let client_builder = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(3))
    .timeout(Duration::from_secs(8));

  let client = if let Some(proxy_url) = proxy {
    let proxy = reqwest::Proxy::all(proxy_url)
      .map_err(|e| IpError::Network(format!("Invalid proxy: {}", e)))?;
    client_builder
      .no_proxy()
      .proxy(proxy)
      .build()
      .map_err(|e| IpError::Network(e.to_string()))?
  } else {
    client_builder
      .build()
      .map_err(|e| IpError::Network(e.to_string()))?
  };

  let mut requests = FuturesUnordered::new();
  for url in urls {
    let client = client.clone();
    requests.push(async move {
      let result = match client.get(url).send().await {
        Ok(response) if response.status().is_success() => match response.text().await {
          Ok(text) => {
            let ip = text.trim().to_string();
            if validate_ip(&ip) {
              Ok(ip)
            } else {
              Err(format!("{url}: response is not an IP address"))
            }
          }
          Err(e) => Err(format!("{url}: {e}")),
        },
        Ok(response) => Err(format!("{url}: HTTP {}", response.status())),
        Err(e) => Err(format!("{url}: {e}")),
      };
      result
    });
  }

  let raced = tokio::time::timeout(Duration::from_secs(8), async {
    let mut errors = Vec::new();
    while let Some(result) = requests.next().await {
      match result {
        Ok(ip) => return Ok(ip),
        Err(error) => errors.push(error),
      }
    }
    Err(errors)
  })
  .await;

  match raced {
    Ok(Ok(ip)) => Ok(ip),
    Ok(Err(errors)) if !errors.is_empty() => Err(IpError::Network(format!(
      "All {} endpoints failed: {}",
      errors.len(),
      errors.join("; ")
    ))),
    Ok(Err(_)) => Err(IpError::Network(
      "Failed to fetch public IP from any endpoint".to_string(),
    )),
    Err(_) => Err(IpError::Network(
      "Public IP lookup timed out after 8 seconds".to_string(),
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_validate_ip() {
    assert!(validate_ip("8.8.8.8"));
    assert!(validate_ip("192.168.1.1"));
    assert!(validate_ip("2001:4860:4860::8888"));
    assert!(!validate_ip("invalid"));
    assert!(!validate_ip("256.256.256.256"));
  }
}
