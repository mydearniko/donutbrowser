use super::types::*;
use futures_util::TryStreamExt;
use reqwest::{Client, RequestBuilder};
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::OnceCell;
use tokio_util::io::{ReaderStream, StreamReader};

const SYNC_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const SYNC_READ_TIMEOUT: Duration = Duration::from_secs(10);
const SYNC_CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

fn build_sync_http_client(read_timeout: Duration) -> Client {
  Client::builder()
    .pool_max_idle_per_host(128)
    .tcp_nodelay(true)
    .http2_adaptive_window(true)
    .connect_timeout(SYNC_CONNECT_TIMEOUT)
    // Unlike a total request timeout, this resets whenever data arrives, so
    // large profile transfers can run for as long as needed while a dead
    // connection cannot leave sync (or profile launch) waiting forever.
    .read_timeout(read_timeout)
    .build()
    .expect("failed to create sync HTTP client")
}

static SYNC_HTTP_CLIENT: LazyLock<Client> =
  LazyLock::new(|| build_sync_http_client(SYNC_READ_TIMEOUT));

#[derive(Clone)]
pub struct SyncClient {
  client: Client,
  base_url: String,
  token: String,
  client_id: String,
  capabilities: Arc<OnceCell<SyncCapabilities>>,
}

impl SyncClient {
  pub fn new(base_url: String, token: String) -> Self {
    Self {
      client: SYNC_HTTP_CLIENT.clone(),
      base_url: base_url.trim_end_matches('/').to_string(),
      token,
      client_id: super::sync_client_id(),
      capabilities: Arc::new(OnceCell::new()),
    }
  }

  fn url(&self, path: &str) -> String {
    format!("{}/v1/objects/{}", self.base_url, path)
  }

  fn storage_url(&self, path: &str) -> String {
    format!("{}/v1/storage/{}", self.base_url, path)
  }

  fn authenticated(&self, request: RequestBuilder) -> RequestBuilder {
    request
      .bearer_auth(&self.token)
      .header("X-Donut-Sync-Client", &self.client_id)
  }

  fn authenticated_control(&self, request: RequestBuilder) -> RequestBuilder {
    self
      .authenticated(request)
      .timeout(SYNC_CONTROL_REQUEST_TIMEOUT)
  }

  pub async fn capabilities(&self) -> SyncCapabilities {
    self
      .capabilities
      .get_or_init(|| async {
        let response = match self
          .authenticated_control(self.client.get(self.url("capabilities")))
          .send()
          .await
        {
          Ok(response) if response.status().is_success() => response,
          Ok(response) => {
            log::debug!(
              "Sync server does not advertise bulk transfer ({})",
              response.status()
            );
            return SyncCapabilities::default();
          }
          Err(error) => {
            log::debug!("Failed to query sync server capabilities: {error}");
            return SyncCapabilities::default();
          }
        };
        response.json().await.unwrap_or_default()
      })
      .await
      .clone()
  }

  pub async fn upload_bundle(
    &self,
    prefix: &str,
    archive_path: &Path,
  ) -> SyncResult<BulkTransferResponse> {
    let file = tokio::fs::File::open(archive_path)
      .await
      .map_err(|error| SyncError::IoError(error.to_string()))?;
    let size = file
      .metadata()
      .await
      .map_err(|error| SyncError::IoError(error.to_string()))?
      .len();
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
    let response = self
      .authenticated(self.client.put(format!(
        "{}?prefix={}",
        self.storage_url("upload-bundle"),
        urlencoding::encode(prefix)
      )))
      .header("Content-Type", "application/gzip")
      .header("Content-Length", size)
      .body(body)
      .send()
      .await
      .map_err(|error| SyncError::NetworkError(error.to_string()))?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Bulk upload failed with status {status}: {body}"
      )));
    }
    response
      .json()
      .await
      .map_err(|error| SyncError::SerializationError(error.to_string()))
  }

  pub async fn download_bundle(
    &self,
    prefix: &str,
    paths: &[String],
    archive_path: &Path,
  ) -> SyncResult<()> {
    let response = self
      .authenticated(self.client.post(self.storage_url("download-bundle")))
      .json(&serde_json::json!({ "prefix": prefix, "paths": paths }))
      .send()
      .await
      .map_err(|error| SyncError::NetworkError(error.to_string()))?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Bulk download failed with status {status}: {body}"
      )));
    }

    let stream = response.bytes_stream().map_err(std::io::Error::other);
    let mut reader = StreamReader::new(stream);
    let mut destination = tokio::fs::File::create(archive_path)
      .await
      .map_err(|error| SyncError::IoError(error.to_string()))?;
    tokio::io::copy(&mut reader, &mut destination)
      .await
      .map_err(|error| SyncError::NetworkError(error.to_string()))?;
    destination
      .flush()
      .await
      .map_err(|error| SyncError::IoError(error.to_string()))
  }

  pub async fn stat(&self, key: &str) -> SyncResult<StatResponse> {
    let response = self
      .authenticated_control(self.client.post(self.url("stat")))
      .json(&StatRequest {
        key: key.to_string(),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn presign_upload(
    &self,
    key: &str,
    content_type: Option<&str>,
  ) -> SyncResult<PresignUploadResponse> {
    self
      .presign_upload_with_metadata(key, content_type, None)
      .await
  }

  /// Presign an upload, asking the server to sign `metadata` into the object as
  /// `x-amz-meta-*`. The response echoes the metadata the server actually signed
  /// (empty/None on older servers); the caller must send exactly that back on
  /// the PUT via `upload_bytes_with_metadata`.
  pub async fn presign_upload_with_metadata(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: Option<std::collections::HashMap<String, String>>,
  ) -> SyncResult<PresignUploadResponse> {
    let response = self
      .authenticated_control(self.client.post(self.url("presign-upload")))
      .json(&PresignUploadRequest {
        key: key.to_string(),
        content_type: content_type.map(|s| s.to_string()),
        expires_in: Some(3600),
        metadata,
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn presign_download(&self, key: &str) -> SyncResult<PresignDownloadResponse> {
    let response = self
      .authenticated_control(self.client.post(self.url("presign-download")))
      .json(&PresignDownloadRequest {
        key: key.to_string(),
        expires_in: Some(3600),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn delete(&self, key: &str, tombstone_key: Option<&str>) -> SyncResult<DeleteResponse> {
    let response = self
      .authenticated(self.client.post(self.url("delete")))
      .json(&DeleteRequest {
        key: key.to_string(),
        tombstone_key: tombstone_key.map(|s| s.to_string()),
        deleted_at: Some(chrono::Utc::now().to_rfc3339()),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn list(&self, prefix: &str) -> SyncResult<ListResponse> {
    self.list_page(prefix, None).await
  }

  pub async fn list_profile_manifests(&self, prefix: &str) -> SyncResult<Vec<ListObject>> {
    let response = self
      .authenticated(self.client.post(self.url("profile-manifests")))
      .json(&ListRequest {
        prefix: prefix.to_string(),
        max_keys: None,
        continuation_token: None,
      })
      .send()
      .await
      .map_err(|error| SyncError::NetworkError(error.to_string()))?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Profile manifest index failed with status {status}: {body}"
      )));
    }
    let response: ListResponse = response
      .json()
      .await
      .map_err(|error| SyncError::SerializationError(error.to_string()))?;
    Ok(response.objects)
  }

  async fn list_page(
    &self,
    prefix: &str,
    continuation_token: Option<String>,
  ) -> SyncResult<ListResponse> {
    let response = self
      .authenticated(self.client.post(self.url("list")))
      .json(&ListRequest {
        prefix: prefix.to_string(),
        max_keys: Some(1000),
        continuation_token,
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  /// List all objects under a prefix, paginating through all results
  pub async fn list_all(&self, prefix: &str) -> SyncResult<Vec<ListObject>> {
    let mut all_objects = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
      let response = self.list_page(prefix, continuation_token).await?;
      all_objects.extend(response.objects);

      if !response.is_truncated {
        break;
      }
      continuation_token = response.next_continuation_token;
      if continuation_token.is_none() {
        break;
      }
    }

    Ok(all_objects)
  }

  pub async fn upload_bytes(
    &self,
    presigned_url: &str,
    data: &[u8],
    content_type: Option<&str>,
  ) -> SyncResult<()> {
    self
      .upload_bytes_with_metadata(presigned_url, data, content_type, None)
      .await
  }

  /// PUT to a presigned URL, sending `metadata` as `x-amz-meta-*` headers. These
  /// MUST be exactly the metadata the presign signed (from
  /// `PresignUploadResponse::metadata`) or S3 rejects the request.
  pub async fn upload_bytes_with_metadata(
    &self,
    presigned_url: &str,
    data: &[u8],
    content_type: Option<&str>,
    metadata: Option<&std::collections::HashMap<String, String>>,
  ) -> SyncResult<()> {
    let mut req = self
      .client
      .put(presigned_url)
      .header("Content-Length", data.len().to_string())
      .body(data.to_vec());

    if let Some(ct) = content_type {
      req = req.header("Content-Type", ct);
    }

    if let Some(meta) = metadata {
      for (k, v) in meta {
        req = req.header(format!("x-amz-meta-{k}"), v);
      }
    }

    let response = req
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Upload failed with status {status}: {body}"
      )));
    }

    Ok(())
  }

  pub async fn download_bytes(&self, presigned_url: &str) -> SyncResult<Vec<u8>> {
    let response = self
      .client
      .get(presigned_url)
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if !response.status().is_success() {
      return Err(SyncError::NetworkError(format!(
        "Download failed with status: {}",
        response.status()
      )));
    }

    response
      .bytes()
      .await
      .map(|b| b.to_vec())
      .map_err(|e| SyncError::NetworkError(e.to_string()))
  }

  pub async fn presign_upload_batch(
    &self,
    items: Vec<(String, Option<String>)>,
  ) -> SyncResult<PresignUploadBatchResponse> {
    let chunk_size = 1000;
    let mut all_items = Vec::new();

    for chunk in items.chunks(chunk_size) {
      let request = PresignUploadBatchRequest {
        items: chunk
          .iter()
          .map(|(key, content_type)| PresignUploadBatchItem {
            key: key.clone(),
            content_type: content_type.clone(),
          })
          .collect(),
        expires_in: Some(3600),
      };

      let response = self
        .authenticated_control(self.client.post(self.url("presign-upload-batch")))
        .json(&request)
        .send()
        .await
        .map_err(|e| SyncError::NetworkError(e.to_string()))?;

      if response.status().is_client_error() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(SyncError::AuthError(format!("({status}) {body}")));
      }

      let batch_response: PresignUploadBatchResponse = response
        .json()
        .await
        .map_err(|e| SyncError::SerializationError(e.to_string()))?;

      all_items.extend(batch_response.items);
    }

    Ok(PresignUploadBatchResponse { items: all_items })
  }

  pub async fn presign_download_batch(
    &self,
    keys: Vec<String>,
  ) -> SyncResult<PresignDownloadBatchResponse> {
    let chunk_size = 1000;
    let mut all_items = Vec::new();

    for chunk in keys.chunks(chunk_size) {
      let request = PresignDownloadBatchRequest {
        keys: chunk.to_vec(),
        expires_in: Some(3600),
      };

      let response = self
        .authenticated_control(self.client.post(self.url("presign-download-batch")))
        .json(&request)
        .send()
        .await
        .map_err(|e| SyncError::NetworkError(e.to_string()))?;

      if response.status().is_client_error() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(SyncError::AuthError(format!("({status}) {body}")));
      }

      let batch_response: PresignDownloadBatchResponse = response
        .json()
        .await
        .map_err(|e| SyncError::SerializationError(e.to_string()))?;

      all_items.extend(batch_response.items);
    }

    Ok(PresignDownloadBatchResponse { items: all_items })
  }

  pub async fn delete_prefix(
    &self,
    prefix: &str,
    tombstone_key: Option<&str>,
  ) -> SyncResult<DeletePrefixResponse> {
    let response = self
      .authenticated(self.client.post(self.url("delete-prefix")))
      .json(&DeletePrefixRequest {
        prefix: prefix.to_string(),
        tombstone_key: tombstone_key.map(|s| s.to_string()),
        deleted_at: Some(chrono::Utc::now().to_rfc3339()),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn stalled_sync_response_hits_the_read_timeout() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
      let (_socket, _) = listener.accept().await.unwrap();
      tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let client = build_sync_http_client(Duration::from_millis(100));

    let error = client
      .get(format!("http://{address}/stall"))
      .send()
      .await
      .unwrap_err();

    assert!(error.is_timeout(), "unexpected error: {error}");
    server.abort();
  }
}
