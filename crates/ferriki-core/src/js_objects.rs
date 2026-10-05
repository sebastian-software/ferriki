//! Batch own-property definitions instead of calling a setter for every field.
//! This preserves JSON's data-property semantics for arbitrary variant names.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CStr;
use std::mem::MaybeUninit;
use std::ptr;

use napi::bindgen_prelude::ToNapiValue;
use napi::{Result, check_status, sys};

use crate::native_types::*;

type ColorCache = Option<(usize, HashMap<String, sys::napi_value>)>;

thread_local! {
    static COLORS: RefCell<ColorCache> = const { RefCell::new(None) };
}

struct ColorScope(ColorCache);

impl Drop for ColorScope {
    fn drop(&mut self) {
        COLORS.with(|cache| {
            cache.replace(self.0.take());
        });
    }
}

// Handles are shared only within one root result's active Node handle scope.
// Restoring the previous cache also supports nested calls without retaining
// any environment or handle after the conversion has finished.
trait Palette {
    fn visit_colors(&self, visit: impl FnMut(&str));
}

impl Palette for HtmlRenderData {
    fn visit_colors(&self, mut visit: impl FnMut(&str)) {
        for token in self.tokens.iter().flatten() {
            if let Some(color) = &token.color {
                visit(color);
            }
        }
    }
}

impl Palette for HtmlRenderDataWithThemes {
    fn visit_colors(&self, mut visit: impl FnMut(&str)) {
        for token in self.tokens.iter().flatten() {
            for style in token.variants.0.values() {
                if let Some(color) = &style.color {
                    visit(color);
                }
            }
        }
        for theme in &self.themes {
            visit(&theme.color);
        }
    }
}

unsafe fn color_scope(env: sys::napi_env, value: &impl Palette) -> Result<ColorScope> {
    let scope =
        ColorScope(COLORS.with(|cache| cache.replace(Some((env as usize, HashMap::new())))));
    // Allocate every shared handle in the root scope before Vec's converters
    // run, so reuse never depends on the library's nested-scope behavior.
    let mut result = Ok(());
    value.visit_colors(|color| {
        if result.is_ok() {
            result = unsafe { color_value(env, color) }.map(|_| ());
        }
    });
    result?;
    Ok(scope)
}

unsafe fn color_value(env: sys::napi_env, value: &str) -> Result<sys::napi_value> {
    let cached = COLORS.with(|cache| {
        cache
            .borrow()
            .as_ref()
            .filter(|(owner, _)| *owner == env as usize)
            .and_then(|(_, colors)| colors.get(value).copied())
    });
    if let Some(cached) = cached {
        return Ok(cached);
    }
    let active = COLORS.with(|cache| {
        cache
            .borrow()
            .as_ref()
            .is_some_and(|(owner, _)| *owner == env as usize)
    });
    // No RefCell borrow spans a Node call, which could trigger a nested call.
    let mut result = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_string_utf8(
            env,
            value.as_ptr().cast(),
            value.len() as isize,
            &mut result,
        )
    })?;
    if active {
        COLORS.with(|cache| {
            if let Some((owner, colors)) = cache.borrow_mut().as_mut()
                && *owner == env as usize
            {
                colors.insert(value.to_owned(), result);
            }
        });
    }
    Ok(result)
}

unsafe fn color_property(
    env: sys::napi_env,
    name: &'static CStr,
    value: String,
) -> Result<sys::napi_property_descriptor> {
    Ok(descriptor(name.as_ptr(), unsafe {
        color_value(env, &value)?
    }))
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

/// The caller owns a live Node environment and keeps every value handle in
/// its current handle scope. Static C strings outlive the definition call.
unsafe fn property<T: ToNapiValue>(
    env: sys::napi_env,
    name: &'static CStr,
    value: T,
) -> Result<sys::napi_property_descriptor> {
    Ok(descriptor(name.as_ptr(), unsafe {
        T::to_napi_value(env, value)?
    }))
}

/// All descriptors contain live handles or static names from the caller's
/// scope. Node copies the descriptors; it does not retain the Rust vector.
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
// adapters only customize allocation: a single property definition per object,
// with missing optional fields omitted exactly as in the former JSON results.
macro_rules! js_object {
    (@property $env:expr, color, $name:expr, $value:expr) => {
        unsafe { color_property($env, $name, $value) }
    };
    (@property $env:expr, $field:ident, $name:expr, $value:expr) => {
        unsafe { property($env, $name, $value) }
    };
    ($type:ty, [$($field:ident => $name:expr),*], [$($optional:ident => $optional_name:expr),*] $(, $scope:ident)?) => {
        impl ToNapiValue for $type {
            unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
                $(let _scope = unsafe { $scope(env, &value)? };)?
                const CAPACITY: usize = (&[$($name,)* $($optional_name,)*] as &[&CStr]).len();
                let mut properties: [MaybeUninit<sys::napi_property_descriptor>; CAPACITY] = [MaybeUninit::uninit(); CAPACITY];
                let mut count = 0;
                $(properties[count].write(js_object!(@property env, $field, $name, value.$field)?); count += 1;)*
                $(if let Some(field) = value.$optional {
                    properties[count].write(js_object!(@property env, $optional, $optional_name, field)?); count += 1;
                })*
                // SAFETY: The prefix through `count` is initialized above.
                // All handles are live; Node copies the descriptors synchronously.
                let properties = unsafe { std::slice::from_raw_parts(properties.as_ptr().cast(), count) };
                unsafe { object(env, properties) }
            }
        }
    };
}

js_object!(HtmlToken, [content => c"content", offset => c"offset"], [color => c"color", font_style => c"fontStyle", token_type => c"type", scope_names => c"scopeNames"]);
js_object!(HtmlRenderData, [tokens => c"tokens", fg => c"fg", bg => c"bg", theme_name => c"themeName"], [], color_scope);
js_object!(ThemeTokenStyle, [], [color => c"color", font_style => c"fontStyle"]);
js_object!(HtmlThemeToken, [content => c"content", offset => c"offset", variants => c"variants"], [token_type => c"type", scope_names => c"scopeNames"]);
js_object!(ThemeMetadata, [color => c"color", name => c"name", foreground => c"foreground", background => c"background"], []);
js_object!(HtmlRenderDataWithThemes, [tokens => c"tokens", themes => c"themes"], [], color_scope);
js_object!(AssetPlanEntry, [path => c"path", digest => c"digest", size => c"size", url => c"url"], []);

impl ToNapiValue for ThemeVariants {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        let mut properties = Vec::with_capacity(value.0.len());
        for (name, style) in value.0 {
            // JS string handles support embedded NUL, unlike C string keys.
            let name = unsafe { String::to_napi_value(env, name)? };
            let style = unsafe { ThemeTokenStyle::to_napi_value(env, style)? };
            let mut entry = descriptor(ptr::null(), style);
            entry.name = name;
            properties.push(entry);
        }
        // SAFETY: Every name and value handle belongs to this active scope.
        unsafe { object(env, &properties) }
    }
}
