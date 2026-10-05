import * as React from "react"

import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative flex w-full touch-none items-center select-none overflow-clip", className)}
      {...props}
    />
  )
}

function SliderTrack({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Track>) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn("relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary", className)}
      {...props}
    />
  )
}

function SliderRange({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Range>) {
  return (
    <SliderPrimitive.Range
      data-slot="slider-range"
      className={cn("absolute h-full bg-primary", className)}
      {...props}
    />
  )
}

function SliderThumb({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Thumb>) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      className={cn(
        "block size-4 rounded-full border border-primary/50 bg-primary shadow transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Slider, SliderTrack, SliderRange, SliderThumb }
