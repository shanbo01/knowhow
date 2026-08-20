fn main() {
    println!("cargo:rerun-if-env-changed=KNOWHOW_PUBLIC_APP_ORIGIN");
    println!("cargo:rerun-if-env-changed=KNOWHOW_DESKTOP_UPDATE_ENDPOINT");
    println!("cargo:rerun-if-env-changed=KNOWHOW_DESKTOP_UPDATER_PUBKEY");
    tauri_build::build();
}
