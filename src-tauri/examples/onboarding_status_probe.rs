//! Headless probe: read the REAL app data dir's onboarding state.

#[tokio::main]
async fn main() {
    let root = kawai_paths::tauri_app_data_dir("pro.kawai.app").expect("app data dir");
    println!("data root: {}", root.display());
    kawai_db::set_data_root(&root);
    let conn = kawai_db::db_connection("dielzzz89@gmail.com").await.unwrap();
    let mut rows = conn
        .query("SELECT key, value FROM onboarding_state", ())
        .await
        .unwrap();
    let mut n = 0;
    while let Some(row) = rows.next().await.unwrap() {
        let k: String = row.get(0).unwrap();
        let v: String = row.get(1).unwrap();
        println!("{k} = {v}");
        n += 1;
    }
    if n == 0 {
        println!("(no rows → completed=false → the gate SHOULD show)");
    }
}
