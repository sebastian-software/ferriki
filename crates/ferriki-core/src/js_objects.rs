//! Batch own-property definitions instead of calling a setter for every field.
//! This preserves JSON's data-property semantics for arbitrary variant names.
//!
//! One `Writer` converts a whole token result. Property keys are internalized
//! once per Node environment instead of once per object, and repeated colors
//! and variant keys share one string handle (#225). The writer emits values
//! through a `Sink`, so tests can check the exact shape without Node.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CStr;
use std::hash::{BuildHasherDefault, Hasher};
use std::mem::MaybeUninit;
use std::ptr;

use napi::bindgen_prelude::ToNapiValue;
use napi::{Result, check_status, sys};

use crate::native_types::*;

/// FNV-1a: colors and theme keys are a handful of short strings per result,
/// where SipHash's setup cost dominates the lookup.
struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
}

macro_rules! keys {
    ($($field:ident => $name:literal),* $(,)?) => {
        #[derive(Clone, Copy)]
        struct Keys<V> {
            $($field: V,)*
        }

        /// Property names in `Keys` field order, NUL-terminated for N-API.
        const KEY_NAMES: &[&str] = &[$(concat!($name, "\0")),*];

        impl<V> Keys<V> {
            fn from_names(mut next: impl FnMut(&'static str) -> Result<V>) -> Result<Self> {
                Ok(Self {
                    $($field: next(concat!($name, "\0"))?,)*
                })
            }
        }
    };
}

keys! {
    content => "content",
    offset => "offset",
    color => "color",
    font_style => "fontStyle",
    token_type => "type",
    scope_names => "scopeNames",
    tokens => "tokens",
    fg => "fg",
    bg => "bg",
    theme_name => "themeName",
    variants => "variants",
    themes => "themes",
    name => "name",
    foreground => "foreground",
    background => "background",
}

/// Creates JavaScript values for the writer.
trait Sink {
    type Value: Copy;

    fn keys(&mut self) -> Result<Keys<Self::Value>>;
    fn string(&mut self, value: &str) -> Result<Self::Value>;
    fn number(&mut self, value: f64) -> Result<Self::Value>;
    fn int(&mut self, value: i32) -> Result<Self::Value>;
    fn uint(&mut self, value: u32) -> Result<Self::Value>;
    fn array(&mut self, length: usize) -> Result<Self::Value>;
    fn set(&mut self, array: Self::Value, index: u32, value: Self::Value) -> Result<()>;
    /// Defines the entries, in order, as own enumerable, writable and
    /// configurable data properties of a new plain object.
    fn object(&mut self, entries: &[(Self::Value, Self::Value)]) -> Result<Self::Value>;
}

type Entry<V> = Option<(V, V)>;

/// Converts one borrowed result. Repeated colors and variant keys reuse a value.
struct Writer<'a, S: Sink> {
    sink: S,
    keys: Keys<S::Value>,
    shared: HashMap<&'a str, S::Value, BuildHasherDefault<Fnv>>,
    variants: Vec<(S::Value, S::Value)>,
}

impl<'a, S: Sink> Writer<'a, S> {
    fn new(mut sink: S) -> Result<Self> {
        Ok(Self {
            keys: sink.keys()?,
            sink,
            shared: HashMap::default(),
            variants: Vec::new(),
        })
    }

    fn shared(&mut self, value: &'a str) -> Result<S::Value> {
        if let Some(handle) = self.shared.get(value) {
            return Ok(*handle);
        }
        let handle = self.sink.string(value)?;
        self.shared.insert(value, handle);
        Ok(handle)
    }

    fn array<T>(
        &mut self,
        items: &'a [T],
        mut item: impl FnMut(&mut Self, &'a T) -> Result<S::Value>,
    ) -> Result<S::Value> {
        let array = self.sink.array(items.len())?;
        for (index, value) in items.iter().enumerate() {
            let value = item(self, value)?;
            self.sink.set(array, index as u32, value)?;
        }
        Ok(array)
    }

    /// Defines the present entries in order; absent ones are omitted.
    fn object<const N: usize>(&mut self, entries: [Entry<S::Value>; N]) -> Result<S::Value> {
        let mut present = [const { MaybeUninit::<(S::Value, S::Value)>::uninit() }; N];
        let mut count = 0;
        for entry in entries.into_iter().flatten() {
            present[count].write(entry);
            count += 1;
        }
        // SAFETY: The prefix through `count` is initialized above.
        let present = unsafe { std::slice::from_raw_parts(present.as_ptr().cast(), count) };
        self.sink.object(present)
    }

    fn scope_names(&mut self, names: &'a [String]) -> Result<S::Value> {
        self.array(names, |writer, name| writer.sink.string(name))
    }

    fn token(&mut self, token: &'a HtmlToken) -> Result<S::Value> {
        let keys = self.keys;
        let entries = [
            Some((keys.content, self.sink.string(&token.content)?)),
            Some((keys.offset, self.sink.number(token.offset)?)),
            match &token.color {
                Some(color) => Some((keys.color, self.shared(color)?)),
                None => None,
            },
            match token.font_style {
                Some(style) => Some((keys.font_style, self.sink.int(style)?)),
                None => None,
            },
            match token.token_type {
                Some(kind) => Some((keys.token_type, self.sink.uint(kind)?)),
                None => None,
            },
            match &token.scope_names {
                Some(names) => Some((keys.scope_names, self.scope_names(names)?)),
                None => None,
            },
        ];
        self.object(entries)
    }

    fn style(&mut self, style: &'a ThemeTokenStyle) -> Result<S::Value> {
        let keys = self.keys;
        let entries = [
            match &style.color {
                Some(color) => Some((keys.color, self.shared(color)?)),
                None => None,
            },
            match style.font_style {
                Some(value) => Some((keys.font_style, self.sink.int(value)?)),
                None => None,
            },
        ];
        self.object(entries)
    }

    fn variants(&mut self, variants: &'a ThemeVariants) -> Result<S::Value> {
        // Reuse one entry buffer instead of allocating one per token.
        let mut entries = std::mem::take(&mut self.variants);
        entries.clear();
        for (name, style) in &variants.0 {
            entries.push((self.shared(name)?, self.style(style)?));
        }
        let value = self.sink.object(&entries);
        self.variants = entries;
        value
    }

    fn theme_token(&mut self, token: &'a HtmlThemeToken) -> Result<S::Value> {
        let keys = self.keys;
        let entries = [
            Some((keys.content, self.sink.string(&token.content)?)),
            Some((keys.offset, self.sink.number(token.offset)?)),
            Some((keys.variants, self.variants(&token.variants)?)),
            match token.token_type {
                Some(kind) => Some((keys.token_type, self.sink.uint(kind)?)),
                None => None,
            },
            match &token.scope_names {
                Some(names) => Some((keys.scope_names, self.scope_names(names)?)),
                None => None,
            },
        ];
        self.object(entries)
    }

    fn theme(&mut self, theme: &'a ThemeMetadata) -> Result<S::Value> {
        let keys = self.keys;
        let entries = [
            Some((keys.color, self.shared(&theme.color)?)),
            Some((keys.name, self.sink.string(&theme.name)?)),
            Some((keys.foreground, self.sink.string(&theme.foreground)?)),
            Some((keys.background, self.sink.string(&theme.background)?)),
        ];
        self.object(entries)
    }

    fn render_data(&mut self, value: &'a HtmlRenderData) -> Result<S::Value> {
        let tokens = self.array(&value.tokens, |writer, line| {
            writer.array(line, |writer, token| writer.token(token))
        })?;
        let keys = self.keys;
        let entries = [
            Some((keys.tokens, tokens)),
            Some((keys.fg, self.sink.string(&value.fg)?)),
            Some((keys.bg, self.sink.string(&value.bg)?)),
            Some((keys.theme_name, self.sink.string(&value.theme_name)?)),
        ];
        self.object(entries)
    }

    fn render_data_with_themes(&mut self, value: &'a HtmlRenderDataWithThemes) -> Result<S::Value> {
        let tokens = self.array(&value.tokens, |writer, line| {
            writer.array(line, |writer, token| writer.theme_token(token))
        })?;
        let themes = self.array(&value.themes, |writer, theme| writer.theme(theme))?;
        let keys = self.keys;
        self.object([Some((keys.tokens, tokens)), Some((keys.themes, themes))])
    }
}

/// Writes into the caller's active handle scope. Every handle it hands out
/// stays live until the N-API callback returns.
struct Napi {
    env: sys::napi_env,
    descriptors: Vec<sys::napi_property_descriptor>,
}

impl Sink for Napi {
    type Value = sys::napi_value;

    fn keys(&mut self) -> Result<Keys<Self::Value>> {
        let names = unsafe { key_names(self.env)? };
        let mut index = 0;
        Keys::from_names(|_| {
            let mut name = ptr::null_mut();
            check_status!(unsafe { sys::napi_get_element(self.env, names, index, &mut name) })?;
            index += 1;
            Ok(name)
        })
    }

    fn string(&mut self, value: &str) -> Result<Self::Value> {
        let mut result = ptr::null_mut();
        let (bytes, length) = (value.as_ptr().cast(), value.len() as isize);
        // ASCII is valid Latin-1, which V8 copies without UTF-8 decoding.
        check_status!(unsafe {
            if value.is_ascii() {
                sys::napi_create_string_latin1(self.env, bytes, length, &mut result)
            } else {
                sys::napi_create_string_utf8(self.env, bytes, length, &mut result)
            }
        })?;
        Ok(result)
    }

    fn number(&mut self, value: f64) -> Result<Self::Value> {
        unsafe { f64::to_napi_value(self.env, value) }
    }

    fn int(&mut self, value: i32) -> Result<Self::Value> {
        unsafe { i32::to_napi_value(self.env, value) }
    }

    fn uint(&mut self, value: u32) -> Result<Self::Value> {
        unsafe { u32::to_napi_value(self.env, value) }
    }

    fn array(&mut self, length: usize) -> Result<Self::Value> {
        let mut array = ptr::null_mut();
        check_status!(unsafe { sys::napi_create_array_with_length(self.env, length, &mut array) })?;
        Ok(array)
    }

    fn set(&mut self, array: Self::Value, index: u32, value: Self::Value) -> Result<()> {
        check_status!(unsafe { sys::napi_set_element(self.env, array, index, value) })
    }

    fn object(&mut self, entries: &[(Self::Value, Self::Value)]) -> Result<Self::Value> {
        self.descriptors.clear();
        // JS string keys support `__proto__` as data and embedded NUL.
        self.descriptors
            .extend(entries.iter().map(|&(name, value)| {
                let mut entry = descriptor(ptr::null(), value);
                entry.name = name;
                entry
            }));
        unsafe { object(self.env, &self.descriptors) }
    }
}

thread_local! {
    /// One referenced key array per live Node environment on this thread.
    static KEY_ARRAYS: RefCell<Vec<(usize, sys::napi_ref)>> = const { RefCell::new(Vec::new()) };
}

/// Returns an array of the internalized property keys, in `KEY_NAMES` order.
/// V8 stores property names internalized, so reading them back from a template
/// object lets later definitions skip the string table; a plain string handle
/// would be looked up again for every object. The array is created once per
/// environment and released by its cleanup hook, before the environment and
/// its references are torn down. Node-API 8 references only objects, so the
/// array, not each string, is referenced.
unsafe fn key_names(env: sys::napi_env) -> Result<sys::napi_value> {
    let cached = KEY_ARRAYS.with(|cache| {
        cache
            .borrow()
            .iter()
            .find(|(owner, _)| *owner == env as usize)
            .map(|(_, reference)| *reference)
    });
    let mut array = ptr::null_mut();
    if let Some(reference) = cached {
        check_status!(unsafe { sys::napi_get_reference_value(env, reference, &mut array) })?;
        return Ok(array);
    }
    let mut undefined = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_undefined(env, &mut undefined) })?;
    let properties = KEY_NAMES
        .iter()
        .map(|name| descriptor(name.as_ptr().cast(), undefined))
        .collect::<Vec<_>>();
    let template = unsafe { object(env, &properties)? };
    check_status!(unsafe {
        sys::napi_get_all_property_names(
            env,
            template,
            sys::KeyCollectionMode::own_only,
            sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
            sys::KeyConversion::keep_numbers,
            &mut array,
        )
    })?;
    let mut reference = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_reference(env, array, 1, &mut reference) })?;
    check_status!(unsafe {
        sys::napi_add_env_cleanup_hook(env, Some(release_key_names), env.cast())
    })?;
    KEY_ARRAYS.with(|cache| cache.borrow_mut().push((env as usize, reference)));
    Ok(array)
}

unsafe extern "C" fn release_key_names(env: *mut std::ffi::c_void) {
    let env = env as sys::napi_env;
    let removed = KEY_ARRAYS.with(|cache| {
        let mut cache = cache.borrow_mut();
        let index = cache.iter().position(|(owner, _)| *owner == env as usize)?;
        Some(cache.swap_remove(index).1)
    });
    if let Some(reference) = removed {
        unsafe { sys::napi_delete_reference(env, reference) };
    }
}

fn descriptor(
    name: *const std::ffi::c_char,
    value: sys::napi_value,
) -> sys::napi_property_descriptor {
    sys::napi_property_descriptor {
        utf8name: name,
        name: ptr::null_mut(),
        method: None,
        getter: None,
        setter: None,
        value,
        attributes: sys::PropertyAttributes::writable
            | sys::PropertyAttributes::enumerable
            | sys::PropertyAttributes::configurable,
        data: ptr::null_mut(),
    }
}

/// All descriptors contain live handles or static names from the caller's
/// scope. Node copies the descriptors; it does not retain the Rust slice.
unsafe fn object(
    env: sys::napi_env,
    properties: &[sys::napi_property_descriptor],
) -> Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_object(env, &mut value) })?;
    check_status!(unsafe {
        sys::napi_define_properties(env, value, properties.len(), properties.as_ptr())
    })?;
    Ok(value)
}

fn napi_writer<'a>(env: sys::napi_env) -> Result<Writer<'a, Napi>> {
    Writer::new(Napi {
        env,
        descriptors: Vec::new(),
    })
}

// The napi(object) structs still own the generated TypeScript shape. These
// adapters only customize allocation, with missing optional fields omitted
// exactly as in the former JSON results.
impl ToNapiValue for HtmlRenderData {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        napi_writer(env)?.render_data(&value)
    }
}

impl ToNapiValue for HtmlRenderDataWithThemes {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        napi_writer(env)?.render_data_with_themes(&value)
    }
}

impl ToNapiValue for AssetPlanEntry {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        unsafe fn property<T: ToNapiValue>(
            env: sys::napi_env,
            name: &'static CStr,
            value: T,
        ) -> Result<sys::napi_property_descriptor> {
            Ok(descriptor(name.as_ptr(), unsafe {
                T::to_napi_value(env, value)?
            }))
        }
        let properties = unsafe {
            [
                property(env, c"path", value.path)?,
                property(env, c"digest", value.digest)?,
                property(env, c"size", value.size)?,
                property(env, c"url", value.url)?,
            ]
        };
        unsafe { object(env, &properties) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::napi_api::tests::standard_highlighter;
    use std::hash::BuildHasher;

    enum Node {
        String(String),
        Number(f64),
        Array(Vec<Option<usize>>),
        Object(Vec<(usize, usize)>),
    }

    /// Records values in an arena and renders them as compact JSON.
    #[derive(Default)]
    struct Recorder {
        nodes: Vec<Node>,
        strings: Vec<String>,
    }

    impl Recorder {
        fn push(&mut self, node: Node) -> usize {
            self.nodes.push(node);
            self.nodes.len() - 1
        }

        fn json(&self, index: usize) -> String {
            match &self.nodes[index] {
                Node::String(value) => serde_json::to_string(value).unwrap(),
                Node::Number(value) if value.fract() == 0.0 => format!("{}", *value as i64),
                Node::Number(value) => value.to_string(),
                Node::Array(items) => format!(
                    "[{}]",
                    items
                        .iter()
                        .map(|item| self.json(item.expect("every element is set")))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                Node::Object(entries) => format!(
                    "{{{}}}",
                    entries
                        .iter()
                        .map(|(name, value)| format!("{}:{}", self.json(*name), self.json(*value)))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            }
        }
    }

    impl Sink for &mut Recorder {
        type Value = usize;

        fn keys(&mut self) -> Result<Keys<usize>> {
            Keys::from_names(|name| Ok(self.push(Node::String(name.trim_end_matches('\0').into()))))
        }

        fn string(&mut self, value: &str) -> Result<usize> {
            self.strings.push(value.into());
            Ok(self.push(Node::String(value.into())))
        }

        fn number(&mut self, value: f64) -> Result<usize> {
            Ok(self.push(Node::Number(value)))
        }

        fn int(&mut self, value: i32) -> Result<usize> {
            Ok(self.push(Node::Number(value.into())))
        }

        fn uint(&mut self, value: u32) -> Result<usize> {
            Ok(self.push(Node::Number(value.into())))
        }

        fn array(&mut self, length: usize) -> Result<usize> {
            Ok(self.push(Node::Array(vec![None; length])))
        }

        fn set(&mut self, array: usize, index: u32, value: usize) -> Result<()> {
            let Node::Array(items) = &mut self.nodes[array] else {
                panic!("not an array")
            };
            items[index as usize] = Some(value);
            Ok(())
        }

        fn object(&mut self, entries: &[(usize, usize)]) -> Result<usize> {
            Ok(self.push(Node::Object(entries.to_vec())))
        }
    }

    fn options(
        lang: &str,
        explanation: Option<napi::bindgen_prelude::Either<String, bool>>,
    ) -> NativeTokenOptions {
        NativeTokenOptions {
            lang: lang.into(),
            theme: "nord".into(),
            include_explanation: explanation,
            tokenize_time_limit: Some(0.0),
            ..Default::default()
        }
    }

    #[test]
    fn single_theme_results_match_the_former_json_transport() {
        let highlighter = standard_highlighter();
        for (lang, code, explanation) in [
            ("javascript", "// 😀 café\r\nconst x = 'ü';\n", None),
            (
                "javascript",
                "console.log(1)",
                Some(napi::bindgen_prelude::Either::A("tokenType".into())),
            ),
            (
                "javascript",
                "a.b",
                Some(napi::bindgen_prelude::Either::B(true)),
            ),
            ("text", "plain\n\ntext", None),
        ] {
            let result = highlighter
                .tokenize(code, options(lang, explanation))
                .expect("tokens");
            let expected = serde_json::to_string(&result).expect("json");
            let data = HtmlRenderData::from(result);
            let mut recorder = Recorder::default();
            let root = Writer::new(&mut recorder)
                .and_then(|mut writer| writer.render_data(&data))
                .expect("written");
            assert_eq!(recorder.json(root), expected, "{lang}: {code:?}");
        }
    }

    #[test]
    fn multi_theme_results_match_and_share_variant_keys() {
        let highlighter = standard_highlighter();
        let keys = ["__proto__", "constructor", "nul\0key", "dünkel", "light"];
        let mut options = options(
            "javascript",
            Some(napi::bindgen_prelude::Either::A("scopeName".into())),
        );
        options.theme_entries = Some(
            keys.iter()
                .enumerate()
                .map(|(index, color)| ThemeEntry {
                    color: (*color).into(),
                    name: if index % 2 == 0 {
                        "nord"
                    } else {
                        "github-light"
                    }
                    .into(),
                })
                .collect(),
        );
        let result = highlighter
            .tokenize_with_themes("const x = 1\nlet y", options)
            .expect("tokens");
        let expected = serde_json::to_string(&result).expect("json");
        let data = HtmlRenderDataWithThemes::from(result);
        let mut recorder = Recorder::default();
        let root = Writer::new(&mut recorder)
            .and_then(|mut writer| writer.render_data_with_themes(&data))
            .expect("written");
        assert_eq!(recorder.json(root), expected);
        // Variant keys are created once, not once per token and theme entry.
        for key in keys {
            let created = recorder
                .strings
                .iter()
                .filter(|value| *value == key)
                .count();
            assert_eq!(created, 1, "{key:?}");
        }
    }

    #[test]
    fn keys_follow_the_declared_names() {
        let mut names = Vec::new();
        let keys = Keys::from_names(|name| {
            names.push(name);
            Ok(names.len() - 1)
        })
        .expect("keys");
        assert_eq!(names, KEY_NAMES);
        assert!(KEY_NAMES.iter().all(|name| name.ends_with('\0')));
        assert_eq!(names[keys.token_type], "type\0");
        assert_eq!(names[keys.theme_name], "themeName\0");
    }

    #[test]
    fn fnv_hashes_distinct_short_keys_apart() {
        let build = BuildHasherDefault::<Fnv>::default();
        let hashes = [
            "#E1E4E8",
            "#F97583",
            "dark",
            "light",
            "__proto__",
            "a\0b",
            "",
        ]
        .map(|value| build.hash_one(value));
        for (index, hash) in hashes.iter().enumerate() {
            assert!(!hashes[index + 1..].contains(hash));
        }
    }
}
