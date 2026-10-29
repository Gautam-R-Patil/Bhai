// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//! Real macOS Liquid Glass: Apple's `NSGlassEffectView` (AppKit, macOS 26+)
//! placed behind an Electron window's web contents. Raw Objective-C runtime
//! FFI, no extra crates. Call from Electron's main-process JS, which runs on
//! the Cocoa main thread. Elsewhere (Linux/Windows, macOS < 26, off the main
//! thread) the exports return false so the caller can fall back to vibrancy.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// `#RRGGBB` / `#RRGGBBAA` → sRGB components in 0..=1.
fn parse_hex_rgba(s: &str) -> Option<[f64; 4]> {
    let h = s.trim().trim_start_matches('#');
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = match h.len() {
        6 => (u32::from_str_radix(h, 16).ok()? << 8) | 0xFF,
        8 => u32::from_str_radix(h, 16).ok()?,
        _ => return None,
    };
    Some([24, 16, 8, 0].map(|shift| ((v >> shift) & 0xFF) as f64 / 255.0))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr::null_mut;

    type Id = *mut c_void;
    type Sel = *const c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_getAssociatedObject(object: Id, key: *const c_void) -> Id;
        fn objc_setAssociatedObject(object: Id, key: *const c_void, value: Id, policy: usize);
    }

    /// `objc_msgSend` cast to the exact C signature of each call. Only
    /// scalar/pointer returns are used, so no `_stret` variant is needed.
    macro_rules! msg {
        ($ret:ty; $obj:expr, $sel:expr $(, $t:ty = $a:expr)*) => {{
            let f: unsafe extern "C" fn(Id, Sel $(, $t)*) -> $ret =
                std::mem::transmute(objc_msgSend as *const ());
            f($obj, sel_registerName(CStr::as_ptr($sel)) $(, $a)*)
        }};
    }

    static GLASS_KEY: u8 = 0;
    const OBJC_ASSOCIATION_RETAIN_NONATOMIC: usize = 1;
    const NS_VIEW_WIDTH_SIZABLE: usize = 2;
    const NS_VIEW_HEIGHT_SIZABLE: usize = 16;
    const NS_WINDOW_BELOW: isize = -1;

    unsafe fn class(name: &CStr) -> Id {
        objc_getClass(name.as_ptr())
    }

    unsafe fn responds(obj: Id, sel: &CStr) -> bool {
        msg!(i8; obj, c"respondsToSelector:", Sel = sel_registerName(sel.as_ptr())) != 0
    }

    fn key() -> *const c_void {
        &GLASS_KEY as *const u8 as *const c_void
    }

    /// Checks shared by attach/detach: on the main thread, and `view` really
    /// is an NSView (so a wrong buffer can't send AppKit selectors to junk).
    unsafe fn usable(view: Id) -> bool {
        !view.is_null()
            && msg!(i8; class(c"NSThread"), c"isMainThread") != 0
            && msg!(i8; view, c"isKindOfClass:", Id = class(c"NSView")) != 0
    }

    pub unsafe fn detach(view: Id) -> bool {
        if !usable(view) {
            return false;
        }
        let old = objc_getAssociatedObject(view, key());
        if old.is_null() {
            return false;
        }
        msg!((); old, c"removeFromSuperview");
        objc_setAssociatedObject(view, key(), null_mut(), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        true
    }

    pub unsafe fn attach(
        view: Id,
        width: f64,
        height: f64,
        corner_radius: f64,
        tint: Option<[f64; 4]>,
        style: Option<i32>,
    ) -> bool {
        let glass_class = class(c"NSGlassEffectView"); // nil before macOS 26
        if glass_class.is_null() || !usable(view) {
            return false;
        }
        detach(view); // idempotent: re-attaching replaces the previous glass

        let frame = CGRect {
            x: 0.0,
            y: 0.0,
            w: width,
            h: height,
        };
        let glass: Id =
            msg!(Id; msg!(Id; glass_class, c"alloc"), c"initWithFrame:", CGRect = frame);
        if glass.is_null() {
            return false;
        }
        msg!((); glass, c"setAutoresizingMask:", usize = NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE);
        if responds(glass, c"setCornerRadius:") {
            msg!((); glass, c"setCornerRadius:", f64 = corner_radius);
        }
        if let Some(style) = style {
            if responds(glass, c"setStyle:") {
                msg!((); glass, c"setStyle:", isize = style as isize);
            }
        }
        if let Some([r, g, b, a]) = tint {
            if responds(glass, c"setTintColor:") {
                let color: Id = msg!(Id; class(c"NSColor"), c"colorWithSRGBRed:green:blue:alpha:",
                    f64 = r, f64 = g, f64 = b, f64 = a);
                msg!((); glass, c"setTintColor:", Id = color);
            }
        }
        // Behind every existing subview, i.e. behind the web contents.
        msg!((); view, c"addSubview:positioned:relativeTo:", Id = glass, isize = NS_WINDOW_BELOW, Id = null_mut());
        // The superview and the association own it now; drop the +1 from alloc.
        objc_setAssociatedObject(view, key(), glass, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        msg!((); glass, c"release");
        true
    }
}

/// `BrowserWindow.getNativeWindowHandle()` → the `NSView*` it holds.
#[cfg(target_os = "macos")]
fn view_from_handle(handle: &[u8]) -> Option<*mut std::ffi::c_void> {
    let bytes: [u8; std::mem::size_of::<usize>()] = handle.try_into().ok()?;
    Some(usize::from_ne_bytes(bytes) as *mut std::ffi::c_void)
}

/// Put Apple's Liquid Glass (`NSGlassEffectView`, macOS 26+) behind the web
/// contents of the window whose `getNativeWindowHandle()` is `handle`. The view
/// tracks the window size. `tintColor` is `#RRGGBB[AA]`; `style` is
/// `NSGlassEffectViewStyle` (0 regular, 1 clear). Re-attaching replaces the
/// previous glass. Returns false when unavailable (macOS < 26, not macOS,
/// off the main thread), so the caller falls back to vibrancy.
#[napi]
pub fn attach_glass_effect(
    handle: Buffer,
    width: f64,
    height: f64,
    corner_radius: f64,
    tint_color: Option<String>,
    style: Option<i32>,
) -> bool {
    #[cfg(target_os = "macos")]
    {
        let tint = tint_color.as_deref().and_then(parse_hex_rgba);
        match view_from_handle(&handle) {
            Some(view) => unsafe { mac::attach(view, width, height, corner_radius, tint, style) },
            None => false,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Remove glass added by `attachGlassEffect`. Returns false if there was none.
#[napi]
pub fn detach_glass_effect(handle: Buffer) -> bool {
    #[cfg(target_os = "macos")]
    {
        match view_from_handle(&handle) {
            Some(view) => unsafe { mac::detach(view) },
            None => false,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::parse_hex_rgba;

    #[test]
    fn parses_hex_tints() {
        assert_eq!(
            parse_hex_rgba("#FF000080"),
            Some([1.0, 0.0, 0.0, 128.0 / 255.0])
        );
        assert_eq!(parse_hex_rgba("00ff00"), Some([0.0, 1.0, 0.0, 1.0]));
        assert_eq!(parse_hex_rgba("#12345"), None);
        assert_eq!(parse_hex_rgba("+12345"), None);
        assert_eq!(parse_hex_rgba("zzzzzz"), None);
    }
}
