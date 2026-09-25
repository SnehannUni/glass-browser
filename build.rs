// Bettet das Icon (assets/glass.ico, erzeugt aus assets/icon.svg) und die Programminfos in die Exe ein.
// Das Icon bekommt die Ressourcen-Nummer 1 – main.rs lädt es von dort als Fenster- und Taskleisten-Icon.
fn main() {
    println!("cargo:rerun-if-changed=assets/glass.ico");
    pdf_assets();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon_with_id("assets/glass.ico", "1")
            .set("FileDescription", "Glass")
            .set("ProductName", "Glass");
        res.compile().expect("Icon konnte nicht eingebettet werden");
    }
}

/// PDF.js (src/pdf/vendor) als Tabelle `(Pfad, Bytes)` für pdf.rs – so muss nicht jede der ~280 Dateien
/// (Schriften, CMaps) von Hand eingetragen werden.
fn pdf_assets() {
    use std::path::{Path, PathBuf};
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("src/pdf/vendor fehlt") {
            let path = entry.unwrap().path();
            if path.is_dir() { walk(&path, out) } else { out.push(path) }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pdf/vendor");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    walk(&root, &mut files);
    files.sort();
    let mut code = String::from("&[\n");
    for file in files {
        let rel = file.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        code += &format!("    ({rel:?}, include_bytes!({:?})),\n", file.display().to_string());
    }
    code += "]\n";
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join("pdf_assets.rs"), code).unwrap();
}
