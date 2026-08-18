import { getIconNameForFileName } from '@/assets/utils'
import { fileExtension, IMAGE_EXTENSIONS } from '@/lib/file-types'

export const FILE_ICON_CDN = 'https://cdn.jsdelivr.net/npm/@lobehub/assets-fileicon@1.0.0/assets'

export interface FileIconProps {
  name: string
  className?: string
}

export function FileIcon({ name, className = "size-4 shrink-0" }: FileIconProps) {
  const ext = fileExtension(name)

  if (IMAGE_EXTENSIONS.has(ext)) {
    return <div className={`bg-muted shrink-0 rounded-md ${className ?? ""}`} />
  }

  const iconName = getIconNameForFileName(name)
  return (
    <img
      src={`${FILE_ICON_CDN}/${iconName}.svg`}
      alt=""
      loading="lazy"
      className={className}
    />
  )
}
