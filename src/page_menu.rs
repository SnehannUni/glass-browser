// Rechtsklick auf Webseiten: WebView2 liefert seine Einträge (Kopieren, Bild speichern …), zeigt aber kein eigenes
// Menü. Die Oberfläche baut daraus ein Glas-Menü; der gewählte Eintrag geht an WebView2 zurück und wird dort
// ausgeführt. Solange das Menü offen ist, wartet WebView2 (Deferral).

use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::PWSTR;

/// Das offene Menü: Nummer, Ereignis und Deferral. Nur eines zugleich.
type Open = Option<(u32, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral)>;
pub type Shared = Rc<RefCell<(u32, Open)>>;

fn text(get: impl FnOnce(&mut PWSTR) -> windows::core::Result<()>) -> String {
    let mut s = PWSTR::null();
    if get(&mut s).is_err() {
        return String::new();
    }
    webview2_com::take_pwstr(s)
}

fn items(list: &ICoreWebView2ContextMenuItemCollection) -> Vec<Value> {
    let mut count = 0;
    unsafe {
        let _ = list.Count(&mut count);
    }
    (0..count)
        .filter_map(|i| {
            let item = unsafe { list.GetValueAtIndex(i) }.ok()?;
            let (mut id, mut kind) = (0, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default());
            let (mut enabled, mut checked) = (windows::core::BOOL::default(), windows::core::BOOL::default());
            unsafe {
                let _ = item.CommandId(&mut id);
                let _ = item.Kind(&mut kind);
                let _ = item.IsEnabled(&mut enabled);
                let _ = item.IsChecked(&mut checked);
            }
            let kind = match kind {
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR => "separator",
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU => "submenu",
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX => "check",
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_RADIO => "radio",
                _ => "command",
            };
            let children = if kind == "submenu" { unsafe { item.Children() }.ok().map(|c| items(&c)).unwrap_or_default() } else { Vec::new() };
            Some(json!({
                "id": id, "kind": kind, "enabled": enabled.as_bool(), "checked": checked.as_bool(),
                "name": text(|s| unsafe { item.Name(s) }),
                "label": text(|s| unsafe { item.Label(s) }),
                "shortcut": text(|s| unsafe { item.ShortcutKeyDescription(s) }),
                "children": children,
            }))
        })
        .collect()
}

/// Rechtsklicks dieses Tabs abfangen. `notify` bekommt die Beschreibung des Menüs (Einträge, Ziel, Stelle in der
/// Webseite in physischen Pixeln).
pub fn watch(webview: &ICoreWebView2, shared: &Shared, notify: impl Fn(Value) + 'static) {
    use windows::core::Interface;
    let Ok(wv11) = webview.cast::<ICoreWebView2_11>() else { return };
    let shared = shared.clone();
    let handler = webview2_com::ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            args.SetHandled(true)?;
            let deferral = args.GetDeferral()?;
            let mut at = windows::Win32::Foundation::POINT::default();
            let _ = args.Location(&mut at);
            let target = args.ContextMenuTarget()?;
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND::default();
            let no = windows::core::BOOL::default;
            let (mut editable, mut has_link, mut has_source, mut has_selection) = (no(), no(), no(), no());
            let _ = target.Kind(&mut kind);
            let _ = target.IsEditable(&mut editable);
            let _ = target.HasLinkUri(&mut has_link);
            let _ = target.HasSourceUri(&mut has_source);
            let _ = target.HasSelection(&mut has_selection);
            let kind = match kind {
                COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE => "image",
                COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO => "video",
                COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_AUDIO => "audio",
                COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_SELECTED_TEXT => "selection",
                _ => "page",
            };
            let menu = {
                let mut s = shared.borrow_mut();
                // Ein neues Menü ersetzt ein noch offenes (das dann nichts ausführt)
                if let Some((_, _, old)) = s.1.take() {
                    let _ = old.Complete();
                }
                s.0 += 1;
                s.1 = Some((s.0, args.clone(), deferral));
                s.0
            };
            notify(json!({
                "menu": menu, "x": at.x, "y": at.y, "kind": kind, "editable": editable.as_bool(),
                "link": if has_link.as_bool() { text(|s| target.LinkUri(s)) } else { String::new() },
                "linkText": if has_link.as_bool() { text(|s| target.LinkText(s)) } else { String::new() },
                "source": if has_source.as_bool() { text(|s| target.SourceUri(s)) } else { String::new() },
                "selection": if has_selection.as_bool() { text(|s| target.SelectionText(s)) } else { String::new() },
                "items": items(&args.MenuItems()?),
            }));
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { wv11.add_ContextMenuRequested(&handler, &mut token) };
}

/// Antwort der Oberfläche: `command` ausführen (oder mit -1 nur schließen).
pub fn pick(shared: &Shared, menu: u32, command: i32) {
    let open = {
        let mut s = shared.borrow_mut();
        if s.1.as_ref().is_some_and(|(m, ..)| *m == menu) { s.1.take() } else { None }
    };
    if let Some((_, args, deferral)) = open {
        unsafe {
            if command >= 0 {
                let _ = args.SetSelectedCommandId(command);
            }
            let _ = deferral.Complete();
        }
    }
}
