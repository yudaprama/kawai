import { useCallback } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useCopyToClipboard } from './use-copy-to-clipboard'

interface UseCopyButtonOptions {
  timeout?: number
  onCopy?: () => void
  onError?: (error: Error) => void
}

/**
 * Shared "copy-to-clipboard" button state: copies `value`, tracks the
 * copied-flashed window, and exposes a swapped Check/Copy icon. Used by the
 * code-block, snippet, commit and terminal copy buttons.
 */
export function useCopyButton(value: string, { timeout = 2000, onCopy, onError }: UseCopyButtonOptions = {}) {
  const { copied, copy } = useCopyToClipboard(timeout)

  const handleCopy = useCallback(async () => {
    if (copied) return
    const ok = await copy(value)
    if (ok) onCopy?.()
    else onError?.(new Error('Clipboard API not available'))
  }, [value, copy, copied, onCopy, onError])

  return { copied, handleCopy, Icon: copied ? CheckIcon : CopyIcon }
}
