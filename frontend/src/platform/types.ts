/**
 * Slim platform contract for the kawai frontend. The vendored ai-elements
 * components call these capabilities; kawai ships a single adapter backed by
 * the standard Web APIs (the Tauri desktop webview is a full browser engine).
 */

export type PlatformTarget = 'desktop' | 'mobile'

export interface PickFilesOptions {
  multiple?: boolean
  accept?: string[]
  capture?: 'user' | 'environment'
}

export interface Platform {
  readonly target: PlatformTarget
  readonly canDictate: boolean
  readonly canCapturePhoto: boolean
  readonly canCaptureScreenshot: boolean
  readonly canReadClipboardImage: boolean
  pickFiles(options?: PickFilesOptions): Promise<File[] | null>
  capturePhoto(): Promise<File | null>
  captureScreenshot(): Promise<File | null>
  writeClipboardText(text: string): Promise<boolean>
  readClipboardImage(): Promise<File | null>
  share(text: string): Promise<void>
}
