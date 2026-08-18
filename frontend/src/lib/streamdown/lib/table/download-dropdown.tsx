import { useContext } from "react";
import { StreamdownContext } from "../../index";
import { useIcons } from "../icon-context";
import { useCn } from "../prefix-context";
import { useTranslations } from "../translations-context";
import { ACTION_BUTTON_CLASSES, save } from "../utils";
import {
  type CSVSeparator,
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
} from "./utils";
import { Dropdown, type DropdownItem } from "../common";

export interface TableDownloadButtonProps {
  children?: React.ReactNode;
  className?: string;
  csvSeparator?: CSVSeparator;
  filename?: string;
  format?: "csv" | "markdown";
  onDownload?: () => void;
  onError?: (error: Error) => void;
}

export const TableDownloadButton = ({
  children,
  className,
  csvSeparator,
  onDownload,
  onError,
  format = "csv",
  filename,
}: TableDownloadButtonProps) => {
  const cn = useCn();
  const { isAnimating } = useContext(StreamdownContext);
  const t = useTranslations();
  const icons = useIcons();

  const downloadTableData = (event: React.MouseEvent<HTMLButtonElement>) => {
    try {
      const button = event.currentTarget;
      const tableWrapper = button.closest('[data-streamdown="table-wrapper"]');
      const tableElement = tableWrapper?.querySelector(
        "table"
      ) as HTMLTableElement;

      if (!tableElement) {
        onError?.(new Error("Table not found"));
        return;
      }

      const tableData = extractTableDataFromElement(tableElement);
      let content = "";
      let mimeType = "";
      let extension = "";

      switch (format) {
        case "csv":
          content = tableDataToCSV(tableData, csvSeparator);
          mimeType = "text/csv";
          extension = "csv";
          break;
        case "markdown":
          content = tableDataToMarkdown(tableData);
          mimeType = "text/markdown";
          extension = "md";
          break;
        default:
          content = tableDataToCSV(tableData, csvSeparator);
          mimeType = "text/csv";
          extension = "csv";
      }

      save(`${filename || "table"}.${extension}`, content, mimeType);

      onDownload?.();
    } catch (error) {
      onError?.(error as Error);
    }
  };

  return (
    <button
      className={cn(
        ACTION_BUTTON_CLASSES,
        className
      )}
      disabled={isAnimating}
      onClick={downloadTableData}
      title={
        format === "csv" ? t.downloadTableAsCsv : t.downloadTableAsMarkdown
      }
      type="button"
    >
      {children ?? <icons.DownloadIcon size={14} />}
    </button>
  );
};

export interface TableDownloadDropdownProps {
  children?: React.ReactNode;
  className?: string;
  csvSeparator?: CSVSeparator;
  onDownload?: (format: "csv" | "markdown") => void;
  onError?: (error: Error) => void;
}

export const TableDownloadDropdown = ({
  children,
  className,
  csvSeparator,
  onDownload,
  onError,
}: TableDownloadDropdownProps) => {
  const cn = useCn();
  const { isAnimating } = useContext(StreamdownContext);
  const t = useTranslations();
  const icons = useIcons();

  const downloadTableData = (format: "csv" | "markdown") => {
    try {
      const tableWrapper = document.querySelector(
        '[data-streamdown="table-wrapper"]'
      );
      const tableElement = tableWrapper?.querySelector(
        "table"
      ) as HTMLTableElement;

      if (!tableElement) {
        onError?.(new Error("Table not found"));
        return;
      }

      const tableData = extractTableDataFromElement(tableElement);
      const content =
        format === "csv"
          ? tableDataToCSV(tableData, csvSeparator)
          : tableDataToMarkdown(tableData);
      const extension = format === "csv" ? "csv" : "md";
      const filename = `table.${extension}`;
      const mimeType = format === "csv" ? "text/csv" : "text/markdown";

      save(filename, content, mimeType);
      onDownload?.(format);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const items: DropdownItem[] = [
    {
      label: t.tableFormatCsv,
      onClick: () => downloadTableData("csv"),
      title: t.downloadTableAsCsv,
    },
    {
      label: t.tableFormatMarkdown,
      onClick: () => downloadTableData("markdown"),
      title: t.downloadTableAsMarkdown,
    },
  ];

  return (
    <Dropdown
      className={cn(className)}
      items={items}
      triggerTitle={t.downloadTable}
      triggerAriaLabel={t.downloadTable}
      disabled={isAnimating}
    >
      {children ?? <icons.DownloadIcon size={14} />}
    </Dropdown>
  );
};