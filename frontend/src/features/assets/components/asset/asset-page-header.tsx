/**
 * AssetPageHeader — shared header for asset-management pages.
 *
 * Vendored from TencentDB-Agent-Memory's MemoryPanel (MIT); the tea-component
 * Card is swapped for the local shadcn Card. Owns only the visual arrangement
 * of title, filters and actions — pages keep their own data, permissions and
 * button states.
 */

import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import "./asset-page-header.css";

interface AssetPageHeaderProps {
  title: string;
  scope?: ReactNode;
  agent?: ReactNode;
  actions?: ReactNode;
  subtitle?: ReactNode;
}

export function AssetPageHeader({ title, scope, agent, actions, subtitle }: AssetPageHeaderProps) {
  return (
    <Card className="_asset-page-header py-0">
      <CardContent className="p-4">
        <div className="_asset-page-header-main">
          <h2 className="_asset-page-header-title">{title}</h2>
          <div className="_asset-page-header-right">
            <div className="_asset-page-header-filters">
              {scope}
              {agent}
            </div>
            {actions && <div className="_asset-page-header-actions">{actions}</div>}
          </div>
        </div>
        {subtitle && <div className="_asset-page-header-subtitle">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}
