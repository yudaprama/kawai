//! Session-scoped knowledge management: file association, knowledge panel list,
//! and session-lifecycle operations (add-to-session, forget, import, delete).

use std::collections::HashMap;

use super::ingest::office_index_file;
use super::schema::{
    associate_session_files, file_chunk_count, purge_file_chunks, rag_file_status, session_file_ids,
};
use super::types::{unix_secs, IndexStatus, KnowledgeFileInfo, STALE_INDEXING_SECS};
use crate::logic::db;

/// List the full metadata of every file associated with a session. Used by the
/// files panel to show "In this session" vs "All documents".
pub async fn list_session_files(
    user_id: &str,
    session_id: i64,
) -> Result<Vec<crate::logic::office::OfficeFile>, String> {
    let conn = db::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    let ids = session_file_ids(&conn, session_id).await?;
    let mut out = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Ok((_path, info)) = crate::logic::office::store::resolve(user_id, id) {
            out.push(info);
        }
    }
    Ok(out)
}

/// The knowledge panel's single list call: every stored office file joined
/// with its index status and its association to the given session. Files with
/// no `rag_files` row read as `not_indexed` (imported before RAG existed).
pub async fn knowledge_list(
    user_id: &str,
    session_id: Option<i64>,
) -> Result<Vec<KnowledgeFileInfo>, String> {
    let conn = db::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    let mut in_session = std::collections::HashSet::new();
    if let Some(sid) = session_id {
        in_session = session_file_ids(&conn, sid).await?.into_iter().collect();
    }

    let mut status_rows = conn
        .query(
            "SELECT file_id, status, chunks, error, raw, updated_at FROM rag_files",
            (),
        )
        .await
        .map_err(|e| format!("rag_files: {e}"))?;
    // (status, chunks, error, raw) per file; stale `indexing` rows become
    // failed/interrupted so a crashed run never spins in the UI.
    let mut statuses: HashMap<String, (String, i64, Option<String>, Option<String>)> = HashMap::new();
    let now = unix_secs();
    while let Some(row) = status_rows
        .next()
        .await
        .map_err(|e| format!("rag_files: {e}"))?
    {
        let fid: String = row.get(0).map_err(|e| format!("rag_files: {e}"))?;
        let status: String = row.get(1).map_err(|e| format!("rag_files: {e}"))?;
        let chunks: i64 = row.get(2).map_err(|e| format!("rag_files: {e}"))?;
        let error: Option<String> = row.get(3).map_err(|e| format!("rag_files: {e}"))?;
        let raw: Option<String> = row.get(4).map_err(|e| format!("rag_files: {e}"))?;
        let updated_at: i64 = row.get(5).map_err(|e| format!("rag_files: {e}"))?;
        let entry = if status == "indexing" && now.saturating_sub(updated_at) > STALE_INDEXING_SECS
        {
            (
                "failed".to_string(),
                chunks,
                Some("indexing interrupted".to_string()),
                raw,
            )
        } else {
            (status, chunks, error, raw)
        };
        statuses.insert(fid, entry);
    }

    let files = crate::logic::office::list_files(user_id)?;
    Ok(files
        .into_iter()
        .map(|f| {
            let is_in_session = in_session.contains(&f.id);
            let (status, chunks, error, raw) = match statuses.get(&f.id) {
                Some((s, c, e, r)) => match s.as_str() {
                    "indexing" => (IndexStatus::Indexing, *c, None, None),
                    "ready" => (IndexStatus::Ready, *c, None, r.clone()),
                    "failed" => (IndexStatus::Failed, *c, e.clone(), r.clone()),
                    _ => (IndexStatus::NotIndexed, 0, None, None),
                },
                None => (IndexStatus::NotIndexed, 0, None, None),
            };
            KnowledgeFileInfo {
                id: f.id,
                original_name: f.original_name,
                ext: f.ext,
                bytes: f.bytes,
                created_at: f.created_at,
                status,
                chunks,
                error,
                in_session: is_in_session,
                raw,
            }
        })
        .collect())
}

/// Remove the given files' session associations and drop the chunks of any
/// file no longer referenced by ANY session (orphans). Used when a file is
/// removed from a session or deleted outright. Safe to call before anything
/// was indexed (missing tables are treated as "nothing to delete").
pub async fn forget_file(
    user_id: String,
    session_id: Option<i64>,
    file_ids: Vec<String>,
) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = db::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    if let Some(sid) = session_id {
        for fid in &file_ids {
            if let Err(e) = conn
                .execute(
                    "DELETE FROM session_files WHERE session_id = ? AND file_id = ?",
                    (sid, fid.clone()),
                )
                .await
            {
                return Err(format!("disassociate: {e}"));
            }
        }
    }

    // Orphan pass: chunks of files with zero remaining associations go away.
    let mut orphans: Vec<String> = Vec::new();
    for fid in &file_ids {
        let mut rows = conn
            .query(
                "SELECT EXISTS (SELECT 1 FROM session_files WHERE file_id = ?)",
                vec![fid.clone()],
            )
            .await
            .map_err(|e| format!("orphan check: {e}"))?;
        let row = rows
            .next()
            .await
            .map_err(|e| format!("orphan check: {e}"))?
            .ok_or_else(|| "orphan check: no row".to_string())?;
        let still_referenced: i64 = row.get(0).map_err(|e| format!("orphan check: {e}"))?;
        if still_referenced == 0 {
            orphans.push(fid.clone());
        }
    }
    for fid in &orphans {
        purge_file_chunks(&conn, fid).await?;
        // The file may still sit in the library, but nothing is indexed
        // anymore — reset its status row so the panel shows `not indexed`.
        conn.execute("DELETE FROM rag_files WHERE file_id = ?", vec![fid.clone()])
            .await
            .map_err(|e| format!("rag_files delete: {e}"))?;
    }
    Ok(orphans.len())
}

/// Associate existing library documents with a session (the knowledge panel's
/// "Add to this session") and make sure they become searchable: files with no
/// chunks — imported before RAG existed, previously purged, or failed — are
/// (re)indexed; files mid-index are left alone. Re-indexing is idempotent
/// (deterministic chunk ids replace). Individual index failures don't abort
/// the batch — they surface per file via the panel's `failed` status.
/// Returns how many files were (re)indexed.
pub async fn knowledge_add_to_session(
    user_id: &str,
    session_id: i64,
    file_ids: &[String],
) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = db::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    // Validate every id against the store before associating anything.
    for fid in file_ids {
        crate::logic::office::store::resolve(user_id, fid)
            .map_err(|e| format!("resolve {fid}: {e}"))?;
    }
    associate_session_files(&conn, session_id, file_ids).await?;

    let mut reindexed = 0usize;
    for fid in file_ids {
        if file_chunk_count(&conn, fid).await? > 0 {
            continue;
        }
        if rag_file_status(&conn, fid).await?.as_deref() == Some("indexing") {
            continue;
        }
        if office_index_file(user_id.to_string(), Some(session_id), fid.clone())
            .await
            .is_ok()
        {
            reindexed += 1;
        }
    }
    Ok(reindexed)
}

/// Language preference for YouTube transcripts, in order.
const YT_LANGS: [&str; 2] = ["en", "id"];

/// Ingest a YouTube video into the knowledge base: fetch its transcript,
/// store it as a markdown document (`yt-<videoId> <title>.md`), associate it
/// with the session and index it. Re-importing a known video just
/// re-associates/re-indexes the existing document (dedupe by name prefix).
pub async fn knowledge_import_youtube(
    user_id: &str,
    session_id: Option<i64>,
    url: &str,
) -> Result<crate::logic::office::OfficeFile, String> {
    let video_id = youtube_transcript::YouTubeTranscript::extract_video_id(url)
        .map_err(|e| format!("not a YouTube URL: {e}"))?;

    // Dedupe: the deterministic `yt-<id>` name prefix identifies a video.
    let prefix = format!("yt-{video_id} ");
    if let Some(existing) = crate::logic::office::list_files(user_id)?
        .into_iter()
        .find(|f| {
            f.original_name.starts_with(&prefix) || f.original_name == format!("yt-{video_id}.md")
        })
    {
        if let Some(sid) = session_id {
            knowledge_add_to_session(user_id, sid, &[existing.id.clone()]).await?;
        }
        return Ok(existing);
    }

    let yt = youtube_transcript::YouTubeTranscript::new();
    let langs = YT_LANGS.to_vec();
    let resp = match yt.fetch_transcript(&video_id, Some(langs)).await {
        Ok(resp) => resp,
        Err(youtube_transcript::TranscriptError::NoTranscriptFound(_, _)) => {
            // Video has no en/id track — fall back to whatever exists.
            let list = yt
                .list_transcripts(&video_id)
                .await
                .map_err(|e| format!("transcript list: {e}"))?;
            let fallback = list
                .all_transcripts()
                .first()
                .ok_or_else(|| "video has no transcripts".to_string())?
                .language_code
                .clone();
            yt.fetch_transcript(&video_id, Some(vec![&fallback]))
                .await
                .map_err(|e| format!("transcript: {e}"))?
        }
        Err(e) => return Err(format!("transcript: {e}")),
    };

    let title = resp.title.clone().unwrap_or_else(|| video_id.clone());
    let body: String = resp
        .transcript
        .iter()
        .map(|item| item.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let markdown =
        format!("# {title} (YouTube)\n\nSource: https://youtu.be/{video_id}\n\n{body}\n");

    let file = crate::logic::office::store::import_bytes(
        user_id,
        &format!("yt-{video_id} {title}.md"),
        markdown.as_bytes(),
    )?;
    if let Some(sid) = session_id {
        knowledge_add_to_session(user_id, sid, &[file.id.clone()]).await?;
    }
    Ok(file)
}

/// Delete a stored document entirely: session associations, indexed chunks
/// (with FTS mirror + vectors), the index status row, and the file itself in
/// the office store. Unlike [`forget_file`] there is no orphan pass — the
/// file is gone unconditionally.
pub async fn office_delete_file(user_id: &str, file_id: &str) -> Result<(), String> {
    // Resolve first: an unknown id errors before anything is deleted.
    let (stored_path, _info) = crate::logic::office::store::resolve(user_id, file_id)
        .map_err(|e| format!("resolve: {e}"))?;

    let conn = db::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    conn.execute(
        "DELETE FROM session_files WHERE file_id = ?",
        vec![file_id.to_string()],
    )
    .await
    .map_err(|e| format!("disassociate: {e}"))?;
    purge_file_chunks(&conn, file_id).await?;
    conn.execute(
        "DELETE FROM rag_files WHERE file_id = ?",
        vec![file_id.to_string()],
    )
    .await
    .map_err(|e| format!("rag_files delete: {e}"))?;

    crate::logic::office::store::delete_file(user_id, &stored_path, file_id)
}
