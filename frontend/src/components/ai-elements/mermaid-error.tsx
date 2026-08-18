import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MermaidErrorComponentProps } from '@/lib/streamdown'

export function MermaidError({ error, retry, chart }: MermaidErrorComponentProps) {
  return (
    <div
      className={cn(
        'border-destructive/50 bg-destructive/10 my-4 rounded-md border p-4',
      )}
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        <span className="font-mono text-sm break-words">{error}</span>
      </div>
      <details className="mt-2">
        <summary className="text-destructive/80 cursor-pointer text-xs">
          {'Show code'}
        </summary>
        <pre className="bg-destructive/10 mt-2 overflow-x-auto rounded p-2 text-xs">
          {chart}
        </pre>
      </details>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={retry}
      >
        <RefreshCw className="size-3.5" />
        {'Retry'}
      </Button>
    </div>
  )
}
