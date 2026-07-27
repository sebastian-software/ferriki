use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use ferriki_textmate::{parse_raw_grammar, GrammarConfiguration, RawGrammar, SyncRegistry};
use napi::{Error, Result};

use crate::asset_catalog::StandardAssetCatalogs;
use crate::theme_data::{parse_theme_data, ThemeData};

pub struct HighlighterCore {
    standard_assets: Option<StandardAssetCatalogs>,
    registry: SyncRegistry,
    aliases: BTreeMap<String, String>,
    loaded_language_ids: BTreeSet<String>,
    injections: BTreeMap<String, Vec<String>>,
    themes: BTreeMap<String, ThemeData>,
    active_theme: Option<String>,
}

impl HighlighterCore {
    pub fn new() -> Result<Self> {
        Ok(Self {
            standard_assets: None,
            registry: SyncRegistry::new(None, None).map_err(theme_error)?,
            aliases: BTreeMap::new(),
            loaded_language_ids: BTreeSet::new(),
            injections: BTreeMap::new(),
            themes: BTreeMap::new(),
            active_theme: None,
        })
    }

    pub fn with_standard_assets(root: &Path) -> Result<Self> {
        let mut highlighter = Self::new()?;
        highlighter.standard_assets = Some(StandardAssetCatalogs::load_from_root(root)?);
        Ok(highlighter)
    }

    pub fn load_standard_theme(&mut self, theme_id: &str) -> Result<bool> {
        if self.themes.contains_key(theme_id) {
            return Ok(true);
        }
        let Some(catalogs) = self.standard_assets.as_ref() else {
            return Ok(false);
        };
        let Some(asset) = catalogs.themes.load_asset(theme_id)? else {
            return Ok(false);
        };
        let theme = parse_theme_data(&asset.id, &asset.theme_json)?;
        self.themes.insert(asset.id.clone(), theme);
        Ok(true)
    }

    pub fn activate_theme(&mut self, theme_id: &str) -> Result<Option<&ThemeData>> {
        if !self.load_standard_theme(theme_id)? {
            return Ok(None);
        }
        if self.active_theme.as_deref() != Some(theme_id) {
            let theme = self
                .themes
                .get(theme_id)
                .ok_or_else(|| Error::from_reason("Loaded Ferriki theme disappeared."))?;
            self.registry
                .set_theme(Some(theme.raw_theme.clone()), None)
                .map_err(theme_error)?;
            self.active_theme = Some(theme_id.to_owned());
        }
        Ok(self.themes.get(theme_id))
    }

    pub fn load_standard_language(&mut self, requested: &str) -> Result<Option<String>> {
        let mut visiting = BTreeSet::new();
        self.load_standard_language_inner(requested, &mut visiting)
    }

    fn load_standard_language_inner(
        &mut self,
        requested: &str,
        visiting: &mut BTreeSet<String>,
    ) -> Result<Option<String>> {
        if self.registry.lookup(requested).is_some() {
            return Ok(Some(requested.to_owned()));
        }
        if let Some(scope_name) = self.aliases.get(requested) {
            return Ok(Some(scope_name.clone()));
        }

        let Some(catalogs) = self.standard_assets.as_ref() else {
            return Ok(None);
        };
        let Some(asset) = catalogs.languages.load_asset(requested)? else {
            return Ok(None);
        };
        let asset = (*asset).clone();
        if self.loaded_language_ids.contains(&asset.id) {
            return Ok(Some(asset.scope_name));
        }
        if !visiting.insert(asset.id.clone()) {
            return Ok(Some(asset.scope_name));
        }

        let injecting_ids = self
            .standard_assets
            .as_ref()
            .expect("standard assets checked above")
            .languages
            .entries_injecting_into(&asset.scope_name)
            .into_iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();

        for dependency in asset
            .embedded_langs
            .iter()
            .chain(asset.embedded_langs_lazy.iter())
        {
            self.load_standard_language_inner(dependency, visiting)?;
        }

        let raw_grammar =
            parse_raw_grammar(&asset.grammar_json, Some("grammar.json")).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to parse standard grammar `{}`: {error}",
                    asset.id
                ))
            })?;
        self.register_loaded_grammar(&asset, raw_grammar);

        for injection_id in injecting_ids {
            self.load_standard_language_inner(&injection_id, visiting)?;
        }
        self.refresh_injections(&asset.scope_name);

        visiting.remove(&asset.id);
        Ok(Some(asset.scope_name))
    }

    fn register_loaded_grammar(
        &mut self,
        asset: &ferriki_asset_gen::LanguageAsset,
        grammar: RawGrammar,
    ) {
        let scope_name = asset.scope_name.clone();
        self.registry.add_grammar(
            grammar,
            self.injections
                .get(&scope_name)
                .cloned()
                .unwrap_or_default(),
        );
        self.aliases.insert(asset.id.clone(), scope_name.clone());
        for alias in &asset.aliases {
            self.aliases.insert(alias.clone(), scope_name.clone());
        }
        for target in &asset.inject_to {
            let injections = self.injections.entry(target.clone()).or_default();
            if !injections.contains(&scope_name) {
                injections.push(scope_name.clone());
            }
            self.refresh_injections(target);
        }
        self.loaded_language_ids.insert(asset.id.clone());
    }

    fn refresh_injections(&mut self, target_scope: &str) {
        let injections = self
            .injections
            .iter()
            .filter(|(target, _)| scope_matches(target, target_scope))
            .flat_map(|(_, injections)| injections.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        self.registry.set_injections(target_scope, injections);
    }

    pub fn resolve_scope(&self, requested: &str) -> Option<String> {
        if self.registry.lookup(requested).is_some() {
            return Some(requested.to_owned());
        }
        self.aliases.get(requested).cloned()
    }

    pub fn loaded_scopes(&self) -> Vec<String> {
        self.loaded_language_ids
            .iter()
            .filter_map(|id| self.aliases.get(id).cloned())
            .collect()
    }

    pub fn grammar_for_language(
        &mut self,
        requested: &str,
    ) -> Result<Option<std::rc::Rc<ferriki_textmate::Grammar>>> {
        let Some(scope_name) = self.load_standard_language(requested)? else {
            return Ok(None);
        };
        self.registry
            .grammar_for_scope_name(
                &scope_name,
                GrammarConfiguration {
                    initial_language_id: 1,
                    balanced_bracket_selectors: Some(vec!["*".to_owned()]),
                    ..GrammarConfiguration::default()
                },
            )
            .map_err(theme_error)
    }
}

fn scope_matches(candidate: &str, scope_name: &str) -> bool {
    candidate == scope_name
        || scope_name
            .strip_prefix(candidate)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn theme_error(error: ferriki_textmate::ThemeError) -> Error {
    Error::from_reason(format!("Failed to resolve TextMate theme: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard_highlighter() -> HighlighterCore {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");
        HighlighterCore::with_standard_assets(&root).expect("highlighter")
    }

    #[test]
    fn loads_standard_language_dependencies_and_aliases() {
        let mut highlighter = standard_highlighter();

        assert_eq!(
            highlighter.load_standard_language("vue").expect("language"),
            Some("text.html.vue".to_owned())
        );
        assert_eq!(
            highlighter.resolve_scope("vue"),
            Some("text.html.vue".to_owned())
        );
        assert!(highlighter
            .loaded_scopes()
            .contains(&"source.js".to_owned()));
        assert!(highlighter
            .loaded_scopes()
            .contains(&"text.html.basic".to_owned()));
        assert!(highlighter
            .grammar_for_language("vue")
            .expect("grammar")
            .is_some());
    }

    #[test]
    fn activates_standard_theme_in_textmate_registry() {
        let mut highlighter = standard_highlighter();
        let theme = highlighter
            .activate_theme("nord")
            .expect("theme")
            .expect("nord");

        assert_eq!(theme.name, "nord");
        assert_eq!(theme.foreground.to_ascii_uppercase(), "#D8DEE9FF");
        assert_eq!(theme.background.to_ascii_uppercase(), "#2E3440FF");
    }

    #[test]
    fn external_injections_are_loaded_for_target_scope() {
        let mut highlighter = standard_highlighter();
        highlighter
            .load_standard_language("typescript")
            .expect("typescript");

        let injections = highlighter.registry.injections("source.ts");
        assert!(injections.contains(&"inline.es6-css".to_owned()));
        assert!(injections.contains(&"inline.es6-html".to_owned()));
    }
}
