import { useContext, useState } from "react";
import { StreamdownContext } from "../../index";
import { useCn } from "../prefix-context";
import { useTranslations } from "../translations-context";
import { ACTION_BUTTON_CLASSES } from "../utils";
import { TableCopyDropdown } from "./copy-dropdown";
import { TableDownloadDropdown } from "./download-dropdown";
import { FullscreenModal, FullscreenButton } from "../common";

interface TableFullscreenButtonProps {
  children: React.ReactNode;
  className?: string;
  showCopy?: boolean;
  showDownload?: boolean;
}

export const TableFullscreenButton = ({
  children,
  className,
  showCopy = true,
  showDownload = true,
}: TableFullscreenButtonProps) => {
  const cn = useCn();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { isAnimating } = useContext(StreamdownContext);
  const t = useTranslations();

  return (
    <>
      <FullscreenButton
        className={cn(ACTION_BUTTON_CLASSES, className)}
        disabled={isAnimating}
        onOpen={() => setIsFullscreen(true)}
        title={t.viewFullscreen}
      />
      <FullscreenModal
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={t.viewFullscreen}
        closeButtonTitle={t.exitFullscreen}
        contentClassName="flex h-full flex-col"
        showCloseButton={true}
      >
        <div className={cn("flex h-full flex-col")}>
          <div className={cn("flex items-center justify-end gap-1 p-4")}>
            {showCopy ? <TableCopyDropdown /> : null}
            {showDownload ? <TableDownloadDropdown /> : null}
          </div>
          <div
            className={cn(
              "flex-1 overflow-auto p-4 pt-0 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10"
            )}
          >
            <table
              className={cn(
                "w-full border-collapse border border-border"
              )}
              data-streamdown="table"
            >
              {children}
            </table>
          </div>
        </div>
      </FullscreenModal>
    </>
  );
};