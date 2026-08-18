export function triggerDownload(
  filename: string,
  content: string | Blob,
  mimeType: string,
) {
  const bom =
    typeof content === 'string' && mimeType.startsWith('text/csv')
      ? '\uFEFF'
      : ''
  const blob =
    typeof content === 'string'
      ? new Blob([bom + content], { type: mimeType })
      : content
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
