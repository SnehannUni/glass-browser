// Bettet das Icon (assets/glass.ico, erzeugt aus assets/icon.svg) und die Programminfos in die Exe ein.
// Das Icon bekommt die Ressourcen-Nummer 1 – main.rs lädt es von dort als Fenster- und Taskleisten-Icon.
fn main() {
    println!("cargo:rerun-if-changed=assets/glass.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon_with_id("assets/glass.ico", "1")
            .set("FileDescription", "Glass")
            .set("ProductName", "Glass");
        res.compile().expect("Icon konnte nicht eingebettet werden");
    }
}
