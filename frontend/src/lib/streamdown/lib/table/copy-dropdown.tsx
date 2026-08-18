import { useContext, useEffect, useRef, useState } from "react";
import { StreamdownContext } from "../../index";
import { useIcons } from "../icon-context";
import { useCn } from "../prefix-context";
import { useTranslations } from "../translations-context";
import {
  type CSVSeparator,
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from "./utils";
import { Dropdown, type DropdownItem } from "../common";

export interface TableCopyDropdownProps {
  children?: React.ReactNode;
  className?: string;
  csvSeparator?: CSVSeparator;
  onCopy?: (format: "csv" | "tsv" | "md") => void;
  onError?: (error: Error) => void;
  timeout?: number;
}

export const TableCopyDropdown = ({
  children,
  className,
  csvSeparator,
  onCopy,
  onError,
  timeout = 2000,
}: TableCopyDropdownProps) => {
  const cn = useCn();
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef(0);
  const { isAnimating } = useContext(StreamdownContext);
  const t = useTranslations();

  const copyTableData = async (format: "csv" | "tsv" | "md") => {
    if (typeof window === "undefined" || !navigator?.clipboard?.write) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

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
      let content = "";

      if (format === "csv") {
        content = tableDataToCSV(tableData, csvSeparator);
      } else if (format === "tsv") {
        content = tableDataToTSV(tableData);
      } else {
        content = tableDataToMarkdown(tableData);
      }

      const clipboardItemData = new ClipboardItem({
        "text/plain": new Blob([content], { type: "text/plain" }),
        "text/html": new Blob([tableElement.outerHTML], {
          type: "text/html",
        }),
      });

      await navigator.clipboard.write([clipboardItemData]);
      setIsCopied(true);
      onCopy?.(format);
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const icons = useIcons();
  const Icon = isCopied ? icons.CheckIcon : icons.CopyIcon;

  const items: DropdownItem[] = [
    {
      label: t.tableFormatMarkdown,
      onClick: () => copyTableData("md"),
      title: t.copyTableAsMarkdown,
    },
    {
      label: t.tableFormatCsv,
      onClick: () => copyTableData("csv"),
      title: t.copyTableAsCsv,
    },
    {
      label: t.tableFormatTsv,
      onClick: () => copyTableData("tsv"),
      title: t.copyTableAsTsv,
    },
  ];

  return (
    <Dropdown
      className={cn(className)}
      items={items}
      triggerTitle={t.copyTable}
      triggerAriaLabel={t.copyTable}
      disabled={isAnimating}
    >
      {children ?? <Icon height={14} width={14} />}
    </Dropdown>
  );
};