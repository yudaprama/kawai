/**
 * Shared media-capture implementations backed by the standard Web APIs
 * (`<input type=file>`, `getUserMedia`, `getDisplayMedia`, Web Speech API).
 *
 * Both the **web** adapter (real browser) and the **Tauri desktop** adapter
 * (WKWebView / WebView2 — full browser engine) compile these in, because the
 * same APIs work in both environments. The **Tauri mobile** adapter reuses the
 * file-input path (native document/camera picker via the `capture` attribute)
 * but gates screen-capture off entirely — there's no `getDisplayMedia` on
 * mobile.
 *
 * Each function normalises to a standard `File` / `File[]` so the caller
 * (`Platform`) can feed results straight into the attachments context without
 * caring about the source.
 *
 * Only browser globals are used here — no `@tauri-apps/*` imports — so this
 * module is safe to compile into the web bundle.
 */

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

import type { PickFilesOptions } from './types'

export type DictationMode = 'speech-recognition' | 'media-recorder' | 'none'

export function detectDictationMode(): DictationMode {
  if (typeof window === 'undefined') return 'none'
  if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) return 'speech-recognition'
  if ('MediaRecorder' in window && 'mediaDevices' in navigator) return 'media-recorder'
  return 'none'
}

export function hasGetUserMedia(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export function hasGetDisplayMedia(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
}

export function hasClipboardRead(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.read === 'function'
}

// ---------------------------------------------------------------------------
// File picker
// ---------------------------------------------------------------------------

/**
 * Opens a transient `<input type=file>` and resolves with the selected files.
 * Resolves `null` when the user cancels. The input is created and removed
 * per-call so multiple concurrent picks don't clash.
 */
export function pickFilesViaInput(options?: PickFilesOptions): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.multiple ?? false
    if (options?.accept?.length) input.accept = options.accept.join(',')
    if (options?.capture) input.setAttribute('capture', options.capture)
    input.style.position = 'fixed'
    input.style.top = '-9999px'
    input.style.opacity = '0'

    let settled = false
    const finish = (files: File[] | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      if (document.body.contains(input)) document.body.removeChild(input)
      resolve(files)
    }

    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : []
      finish(files.length > 0 ? files : null)
    })
    input.addEventListener('cancel', () => finish(null))

    // Some browsers never fire `cancel` — fall back to a focus-timeout heuristic:
    // when the window regains focus shortly after the picker was shown and no
    // `change` event arrived, treat it as a cancel.
    const onFocus = () => {
      timer = window.setTimeout(() => {
        if (!input.files?.length) finish(null)
      }, 400)
    }
    let timer = window.setTimeout(() => finish(null), 60_000)
    window.addEventListener('focus', onFocus)

    document.body.appendChild(input)
    input.click()
  })
}

// ---------------------------------------------------------------------------
// Camera capture
// ---------------------------------------------------------------------------

/**
 * Captures a single still photo from a webcam via `getUserMedia`. Renders a
 * minimal full-screen overlay (video preview + shutter button) into the DOM so
 * the user can frame the shot. Used on **desktop** / **web** where there's no
 * native camera app to hand off to.
 *
 * Resolves `null` when the user cancels or the device has no camera.
 */
export async function capturePhotoViaUserMedia(
  facingMode: 'user' | 'environment' = 'user',
): Promise<File | null> {
  if (!hasGetUserMedia()) return null

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode },
    audio: false,
  })

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.autoplay = true

  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;'

  const frame = document.createElement('div')
  frame.style.cssText = 'position:relative;max-width:90vw;max-height:75vh;overflow:hidden;border-radius:16px;'
  video.style.cssText = 'max-width:90vw;max-height:75vh;display:block;object-fit:contain;'
  frame.appendChild(video)
  overlay.appendChild(frame)

  const hint = document.createElement('p')
  hint.textContent = 'Camera'
  hint.style.cssText = 'color:rgba(255,255,255,.6);font:13px system-ui,sans-serif;margin:0;'
  overlay.appendChild(hint)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;align-items:center;gap:48px;'

  const captureBtn = document.createElement('button')
  captureBtn.type = 'button'
  captureBtn.setAttribute('aria-label', 'Capture photo')
  captureBtn.style.cssText =
    'width:64px;height:64px;border-radius:50%;border:4px solid #fff;background:#fff;' +
    'cursor:pointer;box-shadow:0 0 0 2px rgba(0,0,0,.3);transition:transform .1s;'
  captureBtn.addEventListener('pointerdown', () => (captureBtn.style.transform = 'scale(.9)'))
  captureBtn.addEventListener('pointerup', () => (captureBtn.style.transform = ''))

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = '\u00d7'
  cancelBtn.setAttribute('aria-label', 'Cancel')
  cancelBtn.style.cssText =
    'width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,.15);' +
    'color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;'

  btnRow.append(cancelBtn, captureBtn)
  overlay.appendChild(btnRow)
  document.body.appendChild(overlay)

  return new Promise<File | null>((resolve) => {
    let resolved = false
    const done = (result: File | null) => {
      if (resolved) return
      resolved = true
      if (document.body.contains(overlay)) document.body.removeChild(overlay)
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
      resolve(result)
    }

    video.srcObject = stream
    video.play().catch(() => done(null))
    video.onerror = () => done(null)

    cancelBtn.addEventListener('click', () => done(null))
    captureBtn.addEventListener('click', async () => {
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return done(null)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d')?.drawImage(video, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92))
      if (!blob) return done(null)
      const ts = new Date().toISOString().replaceAll(/[:.]/g, '-')
      done(new File([blob], `photo-${ts}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }))
    })
  })
}

/**
 * Captures a photo on mobile by opening the native camera app via
 * `<input type=file accept=image/* capture>`. Returns the first selected file
 * or `null` on cancel.
 */
export async function capturePhotoViaInput(facingMode: 'user' | 'environment' = 'environment'): Promise<File | null> {
  const files = await pickFilesViaInput({ accept: ['image/*'], capture: facingMode, multiple: false })
  return files?.[0] ?? null
}

// ---------------------------------------------------------------------------
// Screen capture (screenshot)
// ---------------------------------------------------------------------------

/**
 * Captures a screenshot of the user's screen / window via `getDisplayMedia`.
 * Desktop only — `getDisplayMedia` is unavailable on mobile. Resolves `null`
 * when the user denies permission or cancels the picker.
 */
export async function captureScreenshotViaDisplayMedia(): Promise<File | null> {
  if (!hasGetDisplayMedia()) return null

  let stream: MediaStream | null = null
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: true })
    video.srcObject = stream

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Failed to load screen stream'))
    })

    await video.play()

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return null

    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    return new File([blob], `screenshot-${timestamp}.png`, { type: 'image/png', lastModified: Date.now() })
  } finally {
    if (stream) for (const track of stream.getTracks()) track.stop()
    video.pause()
    video.srcObject = null
  }
}

// ---------------------------------------------------------------------------
// Clipboard & sharing (browser fallbacks)
// ---------------------------------------------------------------------------
// Browser-only implementations shared by the web adapter and as a fallback for
// the Tauri adapter (where the plugin path may be unavailable or unsupported).
// No `@tauri-apps/*` imports — safe to compile into the web bundle.

/**
 * Writes plain text to the clipboard. Tries the async Clipboard API first,
 * then a hidden-textarea + `execCommand('copy')` fallback for insecure or
 * restricted contexts. Returns `true` on success.
 */
export async function writeClipboardTextViaBrowser(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy path
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/**
 * Reads an image from the clipboard via `navigator.clipboard.read()`, returning
 * it as a `File`, or `null` when there is no image or the API is unavailable.
 */
export async function readClipboardImageViaBrowser(): Promise<File | null> {
  try {
    if (!navigator?.clipboard?.read) return null
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      const ext = type.split('/')[1] || 'png'
      return new File([blob], `clipboard-${Date.now()}.${ext}`, {
        type,
        lastModified: Date.now(),
      })
    }
  } catch {
    // permission denied, or clipboard holds no image
  }
  return null
}

/**
 * Shares text via the Web Share API when available; otherwise copies it to the
 * clipboard as a fallback (desktop webviews and Android WebView have no share
 * sheet, so the copy fallback is what most native shells actually hit).
 */
export async function shareViaBrowser(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ text })
      return
    }
  } catch {
    // user cancelled or share failed → fall back to copy
  }
  await writeClipboardTextViaBrowser(text)
}
