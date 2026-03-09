use ferriki_asset_gen::{
  LanguageAsset,
  LanguageAssetEntry,
  LanguageManifest,
  ThemeAsset,
  ThemeAssetEntry,
  ThemeManifest,
  decode_language_asset,
  decode_language_manifest,
  decode_theme_asset,
  decode_theme_manifest,
};
use napi::Error;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct LanguageAssetCatalog {
  asset_dir: PathBuf,
  manifest: LanguageManifest,
  entries_by_id: HashMap<String, LanguageAssetEntry>,
  aliases: HashMap<String, String>,
  cache: RefCell<HashMap<String, Arc<LanguageAsset>>>,
}

impl LanguageAssetCatalog {
  pub fn load_from_dir(asset_dir: &Path) -> Result<Self, Error> {
    let manifest_path = asset_dir.join("manifest.fkindex");
    let manifest = decode_language_manifest(&read_bytes(&manifest_path)?)
      .map_err(|err| Error::from_reason(format!("Failed to decode language manifest: {err}")))?;
    let mut entries_by_id = HashMap::with_capacity(manifest.entries.len());
    let mut aliases = HashMap::new();

    for entry in &manifest.entries {
      for alias in &entry.aliases {
        aliases.insert(alias.clone(), entry.id.clone());
      }
      entries_by_id.insert(entry.id.clone(), entry.clone());
    }

    Ok(Self {
      asset_dir: asset_dir.to_path_buf(),
      manifest,
      entries_by_id,
      aliases,
      cache: RefCell::new(HashMap::new()),
    })
  }

  pub fn manifest(&self) -> &LanguageManifest {
    &self.manifest
  }

  pub fn resolve_id(&self, requested: &str) -> Option<&str> {
    if let Some((resolved_id, _entry)) = self.entries_by_id.get_key_value(requested) {
      return Some(resolved_id.as_str());
    }
    self.aliases.get(requested).map(String::as_str)
  }

  pub fn load_asset(&self, requested: &str) -> Result<Option<Arc<LanguageAsset>>, Error> {
    let Some(resolved_id) = self.resolve_id(requested) else {
      return Ok(None);
    };

    if let Some(cached) = self.cache.borrow().get(resolved_id) {
      return Ok(Some(cached.clone()));
    }

    let entry = self.entries_by_id.get(resolved_id)
      .ok_or_else(|| Error::from_reason("Ferriki language asset entry missing after resolution."))?;
    let asset = decode_language_asset(&read_bytes(&self.asset_dir.join(&entry.asset_file))?)
      .map_err(|err| Error::from_reason(format!("Failed to decode language asset `{resolved_id}`: {err}")))?;
    let asset = Arc::new(asset);
    self.cache.borrow_mut().insert(resolved_id.to_owned(), asset.clone());
    Ok(Some(asset))
  }
}

pub struct ThemeAssetCatalog {
  asset_dir: PathBuf,
  manifest: ThemeManifest,
  entries_by_id: HashMap<String, ThemeAssetEntry>,
  cache: RefCell<HashMap<String, Arc<ThemeAsset>>>,
}

impl ThemeAssetCatalog {
  pub fn load_from_dir(asset_dir: &Path) -> Result<Self, Error> {
    let manifest_path = asset_dir.join("manifest.fkindex");
    let manifest = decode_theme_manifest(&read_bytes(&manifest_path)?)
      .map_err(|err| Error::from_reason(format!("Failed to decode theme manifest: {err}")))?;
    let mut entries_by_id = HashMap::with_capacity(manifest.entries.len());
    for entry in &manifest.entries {
      entries_by_id.insert(entry.id.clone(), entry.clone());
    }

    Ok(Self {
      asset_dir: asset_dir.to_path_buf(),
      manifest,
      entries_by_id,
      cache: RefCell::new(HashMap::new()),
    })
  }

  pub fn manifest(&self) -> &ThemeManifest {
    &self.manifest
  }

  pub fn load_asset(&self, requested: &str) -> Result<Option<Arc<ThemeAsset>>, Error> {
    if let Some(cached) = self.cache.borrow().get(requested) {
      return Ok(Some(cached.clone()));
    }

    let Some(entry) = self.entries_by_id.get(requested) else {
      return Ok(None);
    };
    let asset = decode_theme_asset(&read_bytes(&self.asset_dir.join(&entry.asset_file))?)
      .map_err(|err| Error::from_reason(format!("Failed to decode theme asset `{requested}`: {err}")))?;
    let asset = Arc::new(asset);
    self.cache.borrow_mut().insert(requested.to_owned(), asset.clone());
    Ok(Some(asset))
  }
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, Error> {
  fs::read(path)
    .map_err(|err| Error::from_reason(format!("Failed to read `{}`: {err}", path.display())))
}

#[cfg(test)]
mod tests {
  use super::*;
  use ferriki_asset_gen::{AssetSourceRef, generate_catalogs_from_upstream};
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_output_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
  }

  #[test]
  fn language_catalog_resolves_alias_and_caches_asset() {
    let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
    let output_dir = temp_output_dir("language-catalog-loader");
    generate_catalogs_from_upstream(
      &upstream_dir,
      &output_dir,
      AssetSourceRef {
        upstream: "textmate-grammars-themes".to_owned(),
        version: Some("1.0.0".to_owned()),
        commit: Some("abc123".to_owned()),
      },
    )
    .expect("generate");

    let catalog = LanguageAssetCatalog::load_from_dir(&output_dir.join("languages")).expect("catalog");
    assert_eq!(catalog.resolve_id("js"), Some("javascript"));

    let first = catalog.load_asset("js").expect("asset").expect("present");
    let second = catalog.load_asset("javascript").expect("asset").expect("present");
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(first.scope_name, "source.js");

    fs::remove_dir_all(output_dir).expect("cleanup");
  }

  #[test]
  fn theme_catalog_loads_and_caches_asset() {
    let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
    let output_dir = temp_output_dir("theme-catalog-loader");
    generate_catalogs_from_upstream(
      &upstream_dir,
      &output_dir,
      AssetSourceRef {
        upstream: "textmate-grammars-themes".to_owned(),
        version: Some("1.0.0".to_owned()),
        commit: Some("abc123".to_owned()),
      },
    )
    .expect("generate");

    let catalog = ThemeAssetCatalog::load_from_dir(&output_dir.join("themes")).expect("catalog");
    let first = catalog.load_asset("vitesse-light").expect("asset").expect("present");
    let second = catalog.load_asset("vitesse-light").expect("asset").expect("present");
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(first.theme_type.as_deref(), Some("light"));

    fs::remove_dir_all(output_dir).expect("cleanup");
  }
}
