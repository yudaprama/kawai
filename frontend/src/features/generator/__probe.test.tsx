import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";

import { ResultsPaneTabs } from "./generator-shell";

it("dump", () => {
  const html = renderToStaticMarkup(
    <ResultsPaneTabs active="results" onChange={() => {}} resultsLabel="Results (3)" templatesLabel="Templates" />,
  );
  const html2 = renderToStaticMarkup(
    <ResultsPaneTabs active="templates" onChange={() => {}} resultsLabel="Results (3)" templatesLabel="Templates" />,
  );
  writeFileSync(
    "/tmp/kawai-tabs/tabs.html",
    `<!doctype html><html class="dark"><head><meta charset="utf-8"/><link rel="stylesheet" href="./app.css"/><style>body{margin:0;background:#0a0a0a;padding:16px;font-family:system-ui,sans-serif;width:520px}p{font-size:12px;color:#888;margin:16px 0 6px}</style></head><body><p>active: results</p>${html}<p>active: templates</p>${html2}</body></html>`,
  );
});
