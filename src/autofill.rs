use crate::{Browser, UserEvent};
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, os::windows::process::CommandExt, process::{Command, Stdio}, sync::mpsc};
use tao::event_loop::EventLoopProxy;

pub struct Pending {
    pub id: u64,
    tab: u32,
    url: String,
    origin: String,
    host: String,
    token: String,
    x: f64,
    y: f64,
    accounts: Vec<Value>,
    filling: bool,
}

pub fn start(proxy: EventLoopProxy<UserEvent>) -> mpsc::Sender<Value> {
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let root = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("icloud")));
        let Some(root) = root else { return };
        let spawn = || Command::new(root.join("node.exe")).arg(root.join("bridge.mjs"))
            .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
        let mut process = None;
        for request in rx {
            if process.is_none() {
                process = spawn().ok().map(|mut child| {
                    let input = child.stdin.take().unwrap();
                    let output = BufReader::new(child.stdout.take().unwrap());
                    let (replies, receiver) = mpsc::channel();
                    std::thread::spawn(move || {
                        for line in output.lines() {
                            let reply = line.ok().and_then(|line| serde_json::from_str::<Value>(&line).ok());
                            if replies.send(reply).is_err() { break; }
                        }
                    });
                    (child, input, receiver)
                });
            }
            let result = process.as_mut().and_then(|(_, input, output)| {
                writeln!(input, "{request}").ok()?;
                input.flush().ok()?;
                // Also bound the pipe wait if Node or a subprocess stops responding.
                output.recv_timeout(std::time::Duration::from_secs(75)).ok().flatten()
            });
            let reply = result.unwrap_or_else(|| {
                if let Some((mut child, _, _)) = process.take() { let _ = child.kill(); let _ = child.wait(); }
                json!({ "id": request["id"], "error": "iCloud-Anbindung nicht verfügbar. Lokales Setup prüfen." })
            });
            if proxy.send_event(UserEvent::AutofillReply(reply)).is_err() { break; }
        }
        if let Some((mut child, _, _)) = process { let _ = child.kill(); let _ = child.wait(); }
    });
    tx
}

impl Browser {
    pub fn dismiss_autofill(&mut self) {
        self.autofill = None;
        let _ = self.ui.evaluate_script("window.hidePasswordSuggestions?.()");
    }

    pub fn autofill_request(&mut self, tab_id: u32, source: &str, raw: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(raw) else { return };
        if msg["autofill"] == "cancel" {
            if self.autofill.as_ref().is_some_and(|p| p.tab == tab_id && msg["token"] == p.token) { self.dismiss_autofill(); }
            return;
        }
        if msg["autofill"] != "focus" { return; }
        let Some(tab) = self.tabs.get(self.active).filter(|t| t.id == tab_id && t.shows_page()) else { return };
        let Some(Ok(url)) = tab.webview.as_ref().map(|w| w.url()) else { return };
        let Ok(uri) = url.parse::<wry::http::Uri>() else { return };
        let Ok(sender) = source.parse::<wry::http::Uri>() else { return };
        if uri.scheme_str() != Some("https") || sender.scheme() != uri.scheme() || sender.authority() != uri.authority() { return; }
        let Some(host) = uri.host().map(str::to_owned) else { return };
        let Some(token) = msg["token"].as_str().filter(|s| s.len() <= 64) else { return };
        let Some(rect) = msg["rect"].as_array().filter(|a| a.len() == 4) else { return };
        let values: Vec<_> = rect.iter().filter_map(Value::as_f64).filter(|v| v.is_finite()).collect();
        if values.len() != 4 { return; }
        let Some((_, [px, py, width, height])) = self.panes().into_iter().find(|(i, _)| self.tabs[*i].id == tab_id) else { return };
        if values[0] < 0.0 || values[1] < 0.0 || values[0] > width || values[1] > height || values[2] <= 0.0 || values[3] <= 0.0 { return; }
        let origin = format!("https://{}", uri.authority().unwrap());
        self.autofill_seq += 1;
        self.dismiss_autofill();
        let id = self.autofill_seq;
        self.autofill = Some(Pending { id, tab: tab_id, url, origin, host: host.clone(), token: token.to_owned(),
            x: px + values[0], y: py + values[1] + values[3] + 4.0, accounts: Vec::new(), filling: false });
        // Passive lookups stay invisible until iCloud returns a usable response.
        let _ = self.icloud.send(json!({ "id": id, "op": "list", "host": host }));
    }

    fn autofill_current(&self) -> bool {
        self.autofill.as_ref().is_some_and(|p| self.tabs.get(self.active).is_some_and(|t|
            t.id == p.tab && t.shows_page() && t.webview.as_ref().and_then(|w| w.url().ok()).is_some_and(|url| url == p.url)))
    }

    fn show_autofill(&self, message: Option<&str>) {
        if let Some(p) = &self.autofill {
            let data = json!({ "id": p.id, "x": p.x, "y": p.y, "accounts": p.accounts, "message": message,
                "retry": message.is_some_and(|s| s != "iCloud wird verbunden …") });
            let _ = self.ui.evaluate_script(&format!("window.passwordSuggestions?.({data})"));
        }
    }

    pub fn autofill_reply(&mut self, reply: Value) {
        if reply["id"].as_u64() == Some(0) { return; }
        if !self.autofill_current() { self.dismiss_autofill(); return; }
        let Some(p) = self.autofill.as_mut().filter(|p| reply["id"].as_u64() == Some(p.id)) else { return };
        if let Some(error) = reply["error"].as_str() {
            // A focused field is not an explicit request to set up or repair iCloud.
            // Only report failures after the user has selected an account to fill.
            if p.filling {
                p.filling = false;
                self.show_autofill(Some(error));
            } else {
                self.dismiss_autofill();
            }
            return;
        }
        if p.filling {
            if let (Some(username), Some(password)) = (reply["data"]["username"].as_str(), reply["data"]["password"].as_str()) {
                let script = format!("window.__glassAutofillFill?.({}, {}, {}, {})", json!(p.token), json!(p.origin), json!(username), json!(password));
                if let Some(wv) = self.tabs[self.active].webview.as_ref() { let _ = wv.evaluate_script(&script); }
            }
            self.dismiss_autofill();
        } else {
            p.accounts = reply["data"]["accounts"].as_array().cloned().unwrap_or_default();
            self.show_autofill(None);
        }
    }

    pub fn autofill_pick(&mut self, msg: &Value) {
        if !self.autofill_current() { self.dismiss_autofill(); return; }
        let Some(p) = self.autofill.as_mut().filter(|p| msg["id"].as_u64() == Some(p.id) && !p.filling) else { return };
        let Some(account) = msg["index"].as_u64().and_then(|i| p.accounts.get(i as usize)) else { return };
        let Some(username) = account["username"].as_str() else { return };
        self.autofill_seq += 1;
        p.id = self.autofill_seq; p.filling = true;
        let _ = self.icloud.send(json!({ "id": p.id, "op": "fill", "host": p.host, "username": username }));
    }

    pub fn autofill_retry(&mut self, msg: &Value) {
        if !self.autofill_current() { self.dismiss_autofill(); return; }
        let Some(p) = self.autofill.as_mut().filter(|p| msg["id"].as_u64() == Some(p.id) && !p.filling) else { return };
        self.autofill_seq += 1;
        p.id = self.autofill_seq;
        p.accounts.clear();
        let _ = self.ui.evaluate_script("window.hidePasswordSuggestions?.()");
        let _ = self.icloud.send(json!({"id": p.id, "op": "list", "host": p.host}));
        // Passive lookups stay invisible until iCloud returns a usable response.
    }
}
