// Headless smoke test for the TTS path (logic::tts, feature "tts").
// Exercises: model download (first run, ~191 MB fp16) → engine load →
// language detection → synthesis → WAV encode. Writes the audio so it can
// be listened to / inspected.
//
// Usage:
//   cargo run --features tts --example tts_smoke
//   cargo run --features tts --example tts_smoke -- "Texto em português" out.wav
use std::path::PathBuf;

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(run());
}

async fn run() {
    kawai_lib::auth::load_dotenv();

    let text = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Kawai speaks with an on-device neural voice. Supertonic runs on MNN.".into());
    let dest = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "/tmp/kawai-tts-smoke.wav".into());

    let started = std::time::Instant::now();
    let (samples, sample_rate) = kawai_lib::logic::tts::synthesize(&text, None, None)
        .await
        .expect("synthesize");
    let elapsed = started.elapsed();

    let duration_s = samples.len() as f32 / sample_rate as f32;
    let absmax = samples.iter().fold(0f32, |m, &x| m.max(x.abs()));
    println!(
        "[tts_smoke] {sample_rate} Hz, {duration_s:.2}s audio, absmax {absmax:.3}, rtf {:.3}",
        elapsed.as_secs_f32() / duration_s
    );
    assert!(!samples.is_empty(), "empty synthesis");
    assert!(absmax > 0.05, "near-silent audio");

    let wav = kawai_lib::logic::tts::pcm_to_wav(&samples, sample_rate);
    let path = PathBuf::from(&dest);
    std::fs::write(&path, &wav).expect("write wav");
    println!("[tts_smoke] wrote {}", path.display());
}
