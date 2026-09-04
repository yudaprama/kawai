"use client";

import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

type SpeechInputMode = "speech-recognition" | "media-recorder" | "none";

export type SpeechInputProps = ComponentProps<typeof Button> & {
  onTranscriptionChange?: (text: string) => void;
  /**
   * Callback for when audio is recorded using MediaRecorder fallback.
   * This is called in browsers that don't support the Web Speech API (Firefox, Safari).
   * The callback receives an audio Blob that should be sent to a transcription service.
   * Return the transcribed text, which will be passed to onTranscriptionChange.
   */
  onAudioRecorded?: (audioBlob: Blob) => Promise<string>;
  lang?: string;
};

export const detectSpeechInputMode = (): SpeechInputMode => {
  if (typeof window === "undefined") {
    return "none";
  }

  if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    return "speech-recognition";
  }

  if ("MediaRecorder" in window && "mediaDevices" in navigator) {
    return "media-recorder";
  }

  return "none";
};

const isTauriDesktop = (): boolean => {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
};

export const SpeechInput = ({
  className,
  onTranscriptionChange,
  onAudioRecorded,
  lang = "en-US",
  ...props
}: SpeechInputProps) => {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [mode] = useState<SpeechInputMode>(detectSpeechInputMode);
  const [isRecognitionReady, setIsRecognitionReady] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const onTranscriptionChangeRef = useRef<
    SpeechInputProps["onTranscriptionChange"]
  >(onTranscriptionChange);
  const onAudioRecordedRef =
    useRef<SpeechInputProps["onAudioRecorded"]>(onAudioRecorded);

  // Keep refs in sync
  onTranscriptionChangeRef.current = onTranscriptionChange;
  onAudioRecordedRef.current = onAudioRecorded;

  // Initialize Speech Recognition when mode is speech-recognition
  useEffect(() => {
    if (mode !== "speech-recognition") {
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    const speechRecognition = new SpeechRecognition();

    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = lang;

    const handleStart = () => {
      setIsListening(true);
    };

    const handleEnd = () => {
      setIsListening(false);
    };

    const handleResult = (event: Event) => {
      const speechEvent = event as SpeechRecognitionEvent;
      let finalTranscript = "";

      for (
        let i = speechEvent.resultIndex;
        i < speechEvent.results.length;
        i += 1
      ) {
        const result = speechEvent.results[i];
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? "";
        }
      }

      if (finalTranscript) {
        onTranscriptionChangeRef.current?.(finalTranscript);
      }
    };

    const handleError = (event: Event) => {
      setIsListening(false);
      const err = event as SpeechRecognitionErrorEvent;
      if (err?.error === "not-allowed" || err?.error === "service-not-allowed") {
        toast.error("Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone.");
      } else if (err?.error === "no-speech") {
        toast.error("No speech detected. Try again.");
      } else if (err?.error) {
        toast.error(`Speech error: ${err.error}`);
      }
    };

    speechRecognition.addEventListener("start", handleStart);
    speechRecognition.addEventListener("end", handleEnd);
    speechRecognition.addEventListener("result", handleResult);
    speechRecognition.addEventListener("error", handleError);

    recognitionRef.current = speechRecognition;
    setIsRecognitionReady(true);

    return () => {
      speechRecognition.removeEventListener("start", handleStart);
      speechRecognition.removeEventListener("end", handleEnd);
      speechRecognition.removeEventListener("result", handleResult);
      speechRecognition.removeEventListener("error", handleError);
      speechRecognition.stop();
      recognitionRef.current = null;
      setIsRecognitionReady(false);
    };
  }, [mode, lang]);

  // Cleanup MediaRecorder and stream on unmount
  useEffect(
    () => () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
    },
    []
  );

  // Start MediaRecorder recording
  const startMediaRecorder = useCallback(async () => {
    if (!onAudioRecordedRef.current) {
      const isTauri = isTauriDesktop();
      toast.error(
        isTauri
          ? "Speech is unavailable in this desktop app (WKWebView does not support the Web Speech API). Use macOS system dictation (press Fn twice) or open the web version in Chrome/Edge."
          : "Speech transcription is unavailable in this browser. Use Chrome or Edge for speech recognition."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      const handleStop = async () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;

        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        });

        if (audioBlob.size > 0 && onAudioRecordedRef.current) {
          setIsProcessing(true);
          try {
            const transcript = await onAudioRecordedRef.current(audioBlob);
            if (transcript) {
              onTranscriptionChangeRef.current?.(transcript);
            }
          } catch {
            // Error handling delegated to the onAudioRecorded caller
          } finally {
            setIsProcessing(false);
          }
        }
      };

      const handleError = () => {
        setIsListening(false);
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      };

      mediaRecorder.addEventListener("dataavailable", handleDataAvailable);
      mediaRecorder.addEventListener("stop", handleStop);
      mediaRecorder.addEventListener("error", handleError);

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsListening(true);
    } catch (err) {
      setIsListening(false);
      const msg = err instanceof DOMException && err.name === "NotAllowedError"
        ? "Microphone access was denied. Enable microphone permission for Kawai in System Settings → Privacy & Security → Microphone."
        : err instanceof DOMException && err.name === "NotFoundError"
          ? "No microphone was found."
          : "Could not start recording.";
      toast.error(msg);
    }
  }, []);

  // Stop MediaRecorder recording
  const stopMediaRecorder = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isProcessing) return;

    if (mode === "none") {
      toast.error(
        isTauriDesktop()
          ? "Speech is not supported in this desktop app. WKWebView does not provide the Web Speech API — use system dictation (Fn Fn) or open Kawai in Chrome/Edge."
          : "This browser does not support speech recognition. Use Chrome or Edge."
      );
      return;
    }

    if (mode === "speech-recognition" && !isRecognitionReady) {
      toast.error("Speech recognition is not ready yet. Try again in a moment.");
      return;
    }

    if (mode === "speech-recognition" && recognitionRef.current) {
      try {
        if (isListening) {
          recognitionRef.current.stop();
        } else {
          recognitionRef.current.start();
        }
      } catch (err) {
        const msg = err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was denied."
          : "Could not start speech recognition."
        toast.error(msg);
      }
      return;
    }

    if (mode === "media-recorder") {
      if (isListening) {
        stopMediaRecorder();
      } else {
        void startMediaRecorder();
      }
      return;
    }
  }, [mode, isListening, isProcessing, isRecognitionReady, startMediaRecorder, stopMediaRecorder]);

  // Only truly disable while processing a transcription; for unsupported
  // modes we keep the button enabled so the click can show a helpful toast
  // (desktop WKWebView has no Web Speech API → previous "disabled + pointer-events-none"
  // made it look like "nothing happened").
  const isDisabled = isProcessing;

  const disabledReason =
    mode === "none"
      ? isTauriDesktop()
        ? "Speech is unavailable in desktop WKWebView. Use system dictation or Chrome/Edge."
        : "Speech is unavailable in this browser. Use Chrome or Edge."
      : mode === "speech-recognition" && !isRecognitionReady
        ? "Menyiapkan speech recognition…"
        : mode === "media-recorder" && !onAudioRecorded
          ? isTauriDesktop()
            ? "Transcription is not configured for desktop. Use system dictation."
            : "Transcription is not configured."
          : undefined;

  return (
    <div className="relative inline-flex items-center justify-center">
      {/* Animated pulse rings */}
      {isListening &&
        [0, 1, 2].map((index) => (
          <div
            className="absolute inset-0 animate-ping rounded-full border-2 border-destructive/30"
            key={index}
            style={{
              animationDelay: `${index * 0.3}s`,
              animationDuration: "2s",
            }}
          />
        ))}

      {/* Main record button */}
      <Button
        aria-label={isListening ? "Stop recording" : disabledReason ? "Speech unavailable" : "Start dictation"}
        className={cn(
          "relative z-10 rounded-full transition-all duration-300",
          isListening
            ? "bg-destructive text-white hover:bg-destructive/80 hover:text-white"
            : "bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground",
          className
        )}
        disabled={isDisabled}
        onClick={toggleListening}
        title={disabledReason ?? (isListening ? "Stop" : "Start dictation")}
        {...props}
      >
        {isProcessing && <Spinner />}
        {!isProcessing && isListening && <SquareIcon className="size-4" />}
        {!(isProcessing || isListening) && <MicIcon className="size-4" />}
      </Button>
    </div>
  );
};
