import { type ComponentProps, useContext, useState } from "react";
import { StreamdownContext } from "../../index";
import type { MermaidConfig } from "../plugin-types";
import { useCn } from "../prefix-context";
import { useTranslations } from "../translations-context";
import { ACTION_BUTTON_CLASSES } from "../utils";
import { Mermaid } from ".";
import { FullscreenModal, FullscreenButton } from "../common";

type MermaidFullscreenButtonProps = ComponentProps<"button"> & {
  chart: string;
  config?: MermaidConfig;
  onFullscreen?: () => void;
  onExit?: () => void;
};

function resolveMermaidFullscreenPortalContainer(
  mermaidOptions: { fullscreenPortalContainer?: HTMLElement | (() => HTMLElement | null) | null } | undefined
): HTMLElement {
  const configured = mermaidOptions?.fullscreenPortalContainer;
  if (configured === undefined || configured === null) {
    return document.body;
  }
  if (typeof configured === "function") {
    return configured() ?? document.body;
  }
  return configured;
}

export const MermaidFullscreenButton = ({
  chart,
  config,
  onFullscreen,
  onExit,
  className,
  ...props
}: MermaidFullscreenButtonProps) => {
  const cn = useCn();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const {
    isAnimating,
    controls: controlsConfig,
    mermaid: mermaidOptions,
  } = useContext(StreamdownContext);
  const t = useTranslations();

  const showPanZoomControls = (() => {
    if (typeof controlsConfig === "boolean") {
      return controlsConfig;
    }
    const mermaidCtl = controlsConfig.mermaid;
    if (mermaidCtl === false) {
      return false;
    }
    if (mermaidCtl === true || mermaidCtl === undefined) {
      return true;
    }
    return mermaidCtl.panZoom !== false;
  })();

  return (
    <>
      <FullscreenButton
        className={cn(ACTION_BUTTON_CLASSES, className)}
        disabled={isAnimating}
        onOpen={() => setIsFullscreen(true)}
        onClose={onExit}
        title={t.viewFullscreen}
        {...props}
      />
      <FullscreenModal
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={t.viewFullscreen}
        closeButtonTitle={t.exitFullscreen}
        onOpen={onFullscreen}
        onExit={onExit}
        portalContainer={resolveMermaidFullscreenPortalContainer(mermaidOptions)}
        contentClassName="flex size-full items-center justify-center"
      >
        <Mermaid
          chart={chart}
          className={cn("size-full [&_svg]:h-auto [&_svg]:w-auto")}
          config={config}
          fullscreen={true}
          showControls={showPanZoomControls}
        />
      </FullscreenModal>
    </>
  );
};