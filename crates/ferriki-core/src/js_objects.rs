//! Batch own-property definitions instead of calling a setter for every field.
//! This preserves JSON's data-property semantics for arbitrary variant names.
//!
//! One `Writer` converts a whole token result. It creates each property key
//! once, so V8 internalizes it once instead of once per object, and it shares
//! one string handle per distinct color and variant key (#225).
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
        struct Keys {
            $($field: sys::napi_value,)*
        }

        impl Keys {
            unsafe fn new(env: sys::napi_env) -> Result<Self> {
                let names = unsafe {
                    key_names(env, &[$(concat!($name, "\0").as_ptr().cast()),*])?
                };
                let mut index = 0;
                let mut next = || -> Result<sys::napi_value> {
                    let mut name = ptr::null_mut();
                    check_status!(unsafe { sys::napi_get_element(env, names, index, &mut name) })?;
                    index += 1;
                    Ok(name)
                };
                Ok(Self {
                    $($field: next()?,)*
                })
            }
        }
    };
}

thread_local! {
    /// One referenced key array per live Node environment on this thread.
    static KEY_NAMES: RefCell<Vec<(usize, sys::napi_ref)>> = const { RefCell::new(Vec::new()) };
}

/// Returns an array of the internalized property keys, in `names` order. V8
/// stores property names internalized, so reading them back from a template
/// object lets later definitions skip the string table; a plain string handle
/// would be looked up again for every object. The array is created once per
/// environment and released by its cleanup hook, before the environment and
/// its references are torn down. Node-API 8 references only objects, so the
/// array, not each string, is referenced.
unsafe fn key_names(
    env: sys::napi_env,
    names: &[*const std::ffi::c_char],
) -> Result<sys::napi_value> {
    let cached = KEY_NAMES.with(|cache| {
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
    let properties = names
        .iter()
        .map(|name| descriptor(*name, undefined))
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
    KEY_NAMES.with(|cache| cache.borrow_mut().push((env as usize, reference)));
    Ok(array)
}

unsafe extern "C" fn release_key_names(env: *mut std::ffi::c_void) {
    let env = env as sys::napi_env;
    let removed = KEY_NAMES.with(|cache| {
        let mut cache = cache.borrow_mut();
        let index = cache.iter().position(|(owner, _)| *owner == env as usize)?;
        Some(cache.swap_remove(index).1)
    });
    if let Some(reference) = removed {
        unsafe { sys::napi_delete_reference(env, reference) };
    }
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

/// Converts one borrowed result inside the caller's active handle scope. Every
/// handle it hands out stays live until the N-API callback returns.
struct Writer<'a> {
    env: sys::napi_env,
    keys: Keys,
    shared: HashMap<&'a str, sys::napi_value, BuildHasherDefault<Fnv>>,
    variants: Vec<sys::napi_property_descriptor>,
}

impl<'a> Writer<'a> {
    unsafe fn new(env: sys::napi_env) -> Result<Self> {
        Ok(Self {
            env,
            keys: unsafe { Keys::new(env)? },
            shared: HashMap::default(),
            variants: Vec::new(),
        })
    }

    unsafe fn string(&self, value: &str) -> Result<sys::napi_value> {
        // ASCII is valid Latin-1, which V8 copies without UTF-8 decoding.
        if value.is_ascii() {
            return unsafe { latin1(self.env, value) };
        }
        let mut result = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_string_utf8(
                self.env,
                value.as_ptr().cast(),
                value.len() as isize,
                &mut result,
            )
        })?;
        Ok(result)
    }

    /// Reuses one handle for repeated colors and theme keys.
    unsafe fn shared(&mut self, value: &'a str) -> Result<sys::napi_value> {
        if let Some(handle) = self.shared.get(value) {
            return Ok(*handle);
        }
        let handle = unsafe { self.string(value)? };
        self.shared.insert(value, handle);
        Ok(handle)
    }

    unsafe fn number(&self, value: f64) -> Result<sys::napi_value> {
        unsafe { f64::to_napi_value(self.env, value) }
    }

    unsafe fn int(&self, value: i32) -> Result<sys::napi_value> {
        unsafe { i32::to_napi_value(self.env, value) }
    }

    unsafe fn uint(&self, value: u32) -> Result<sys::napi_value> {
        unsafe { u32::to_napi_value(self.env, value) }
    }

    unsafe fn array<T>(
        &mut self,
        items: &'a [T],
        mut item: impl FnMut(&mut Self, &'a T) -> Result<sys::napi_value>,
    ) -> Result<sys::napi_value> {
        let mut array = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_array_with_length(self.env, items.len(), &mut array)
        })?;
        for (index, value) in items.iter().enumerate() {
            let value = item(self, value)?;
            check_status!(unsafe { sys::napi_set_element(self.env, array, index as u32, value) })?;
        }
        Ok(array)
    }

    /// Defines the present entries, in order, with one N-API call.
    unsafe fn object<const N: usize>(
        &self,
        entries: [Option<(sys::napi_value, sys::napi_value)>; N],
    ) -> Result<sys::napi_value> {
        let mut properties = [MaybeUninit::<sys::napi_property_descriptor>::uninit(); N];
        let mut count = 0;
        for (name, value) in entries.into_iter().flatten() {
            let mut entry = descriptor(ptr::null(), value);
            entry.name = name;
            properties[count].write(entry);
            count += 1;
        }
        // SAFETY: The prefix through `count` is initialized above.
        let properties = unsafe { std::slice::from_raw_parts(properties.as_ptr().cast(), count) };
        unsafe { object(self.env, properties) }
    }

    unsafe fn scope_names(&mut self, names: &'a [String]) -> Result<sys::napi_value> {
        unsafe { self.array(names, |writer, name| writer.string(name)) }
    }

    unsafe fn token(&mut self, token: &'a HtmlToken) -> Result<sys::napi_value> {
        let keys = self.keys;
        let entries = [
            Some((keys.content, unsafe { self.string(&token.content)? })),
            Some((keys.offset, unsafe { self.number(token.offset)? })),
            match &token.color {
                Some(color) => Some((keys.color, unsafe { self.shared(color)? })),
                None => None,
            },
            match token.font_style {
                Some(style) => Some((keys.font_style, unsafe { self.int(style)? })),
                None => None,
            },
            match token.token_type {
                Some(kind) => Some((keys.token_type, unsafe { self.uint(kind)? })),
                None => None,
            },
            match &token.scope_names {
                Some(names) => Some((keys.scope_names, unsafe { self.scope_names(names)? })),
                None => None,
            },
        ];
        unsafe { self.object(entries) }
    }

    unsafe fn style(&mut self, style: &'a ThemeTokenStyle) -> Result<sys::napi_value> {
        let keys = self.keys;
        let entries = [
            match &style.color {
                Some(color) => Some((keys.color, unsafe { self.shared(color)? })),
                None => None,
            },
            match style.font_style {
                Some(value) => Some((keys.font_style, unsafe { self.int(value)? })),
                None => None,
            },
        ];
        unsafe { self.object(entries) }
    }

    unsafe fn variants(&mut self, variants: &'a ThemeVariants) -> Result<sys::napi_value> {
        // Reuse one descriptor buffer instead of allocating one per token.
        let mut properties = std::mem::take(&mut self.variants);
        properties.clear();
        for (name, style) in &variants.0 {
            // JS string handles support embedded NUL, unlike C string keys.
            let name = unsafe { self.shared(name)? };
            let style = unsafe { self.style(style)? };
            let mut entry = descriptor(ptr::null(), style);
            entry.name = name;
            properties.push(entry);
        }
        // SAFETY: Every name and value handle belongs to this active scope.
        let value = unsafe { object(self.env, &properties) };
        self.variants = properties;
        value
    }

    unsafe fn theme_token(&mut self, token: &'a HtmlThemeToken) -> Result<sys::napi_value> {
        let keys = self.keys;
        let entries = [
            Some((keys.content, unsafe { self.string(&token.content)? })),
            Some((keys.offset, unsafe { self.number(token.offset)? })),
            Some((keys.variants, unsafe { self.variants(&token.variants)? })),
            match token.token_type {
                Some(kind) => Some((keys.token_type, unsafe { self.uint(kind)? })),
                None => None,
            },
            match &token.scope_names {
                Some(names) => Some((keys.scope_names, unsafe { self.scope_names(names)? })),
                None => None,
            },
        ];
        unsafe { self.object(entries) }
    }

    unsafe fn theme(&mut self, theme: &'a ThemeMetadata) -> Result<sys::napi_value> {
        let keys = self.keys;
        let entries = [
            Some((keys.color, unsafe { self.shared(&theme.color)? })),
            Some((keys.name, unsafe { self.string(&theme.name)? })),
            Some((keys.foreground, unsafe { self.string(&theme.foreground)? })),
            Some((keys.background, unsafe { self.string(&theme.background)? })),
        ];
        unsafe { self.object(entries) }
    }
}

unsafe fn latin1(env: sys::napi_env, value: &str) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_string_latin1(
            env,
            value.as_ptr().cast(),
            value.len() as isize,
            &mut result,
        )
    })?;
    Ok(result)
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

// The napi(object) structs still own the generated TypeScript shape. These
// adapters only customize allocation, with missing optional fields omitted
// exactly as in the former JSON results.
impl ToNapiValue for HtmlRenderData {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        let mut writer = unsafe { Writer::new(env)? };
        let tokens = unsafe {
            writer.array(&value.tokens, |writer, line| {
                writer.array(line, |writer, token| writer.token(token))
            })?
        };
        let keys = writer.keys;
        let entries = [
            Some((keys.tokens, tokens)),
            Some((keys.fg, unsafe { writer.string(&value.fg)? })),
            Some((keys.bg, unsafe { writer.string(&value.bg)? })),
            Some((keys.theme_name, unsafe {
                writer.string(&value.theme_name)?
            })),
        ];
        unsafe { writer.object(entries) }
    }
}

impl ToNapiValue for HtmlRenderDataWithThemes {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        let mut writer = unsafe { Writer::new(env)? };
        let tokens = unsafe {
            writer.array(&value.tokens, |writer, line| {
                writer.array(line, |writer, token| writer.theme_token(token))
            })?
        };
        let themes = unsafe { writer.array(&value.themes, |writer, theme| writer.theme(theme))? };
        let entries = [
            Some((writer.keys.tokens, tokens)),
            Some((writer.keys.themes, themes)),
        ];
        unsafe { writer.object(entries) }
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
    use std::hash::BuildHasher;

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
