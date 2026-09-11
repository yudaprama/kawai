import { FileIcon } from "@/components/shared/file-icon";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { fmtBytes, fmtDate, isRecord, pick, toNum } from "./format";
import { SectionLabel } from "./atoms";

// ── file-list ───────────────────────────────────────────────────────────────

/** office_list_files → {"files": [{id, originalName, ext, bytes, createdAt}]} */
export function FileListView({ data }: { data: Record<string, unknown> }) {
  const files = Array.isArray(data.files) ? data.files.filter(isRecord) : [];
  if (files.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{files.length} dokumen ditemukan</SectionLabel>
      <ul className="space-y-1.5">
        {files.slice(0, 30).map((f, i) => {
          const name = pick<string>(f, "originalName", "original_name", "name") ?? "Tanpa nama";
          const bytes = toNum(pick(f, "bytes", "size"));
          const created = fmtDate(pick(f, "createdAt", "created_at"));
          const id = pick<string>(f, "id");
          return (
            <li className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2" key={id ?? i}>
              <button
                className="flex items-center gap-3 text-left hover:underline"
                onClick={() => id && emitOpenPreview(id, name)}
                title={`Buka ${name}`}
                type="button"
              >
                <FileIcon className="size-5 shrink-0" name={name} />
                <div className="min-w-0">
                  <div className="text-foreground truncate text-sm" title={name}>
                    {name}
                  </div>
                  <div className="text-muted-foreground truncate font-mono text-[11px]" title={id}>
                    {id}
                  </div>
                </div>
              </button>
              <div className="text-muted-foreground shrink-0 text-right font-mono text-[11px]">
                {bytes != null && <div>{fmtBytes(bytes)}</div>}
                {created && <div>{created}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {files.length > 30 && <SectionLabel>…dan {files.length - 30} dokumen lainnya</SectionLabel>}
    </div>
  );
}

// ── file-created (pdf_create_from_markdown and friends) ────────────────────

/** A tool result that created one stored file → single file card with
 *  human metadata (name / size / created) instead of raw JSON. */
export function FileCreatedView({ data }: { data: Record<string, unknown> }) {
  const file = isRecord(data.file) ? data.file : data;
  const id = pick<string>(file, "id", "fileId") ?? "";
  const name = pick<string>(file, "originalName", "original_name", "filename", "name") ?? "Dokumen";
  if (!id) return null;
  const bytes = toNum(pick(file, "bytes", "size"));
  const created = fmtDate(pick(file, "createdAt", "created_at"));
  return (
    <button
      className="bg-card flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-accent/40"
      onClick={() => emitOpenPreview(id, name ?? id)}
      title={`Buka ${name ?? id}`}
      type="button"
    >
      <FileIcon className="size-5 shrink-0" name={name ?? id} />
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm" title={name ?? id}>
          {name ?? id}
        </div>
        <div className="text-muted-foreground text-xs">Dokumen berhasil dibuat</div>
      </div>
      <div className="text-muted-foreground shrink-0 text-right font-mono text-[11px]">
        {bytes != null && <div>{fmtBytes(bytes)}</div>}
        {created && <div>{created}</div>}
      </div>
    </button>
  );
}
