// Throwaway smoke: SecurityAuditForm initial markup (All chip, labeled intensity, hints).
import { renderToStaticMarkup } from "react-dom/server";
import { SecurityAuditForm } from "/Users/yuda/ai-orchestration/kawai/frontend/src/features/workbench/components/security-audit-form.tsx";

const html = renderToStaticMarkup(<SecurityAuditForm onSubmit={() => {}} />);

const expect = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
};

expect(html.includes(">All</button>"), "All chip rendered");
expect(/aria-pressed="false"[^>]*>All</.test(html), "All starts inactive (2 of 10 selected)");
expect(html.includes("minimal · 50 payloads"), "minimal option labeled with payload count");
expect(html.includes("standard · 500 payloads"), "standard option labeled with payload count");
expect(html.includes("extended · 5,000 payloads"), "extended option labeled with payload count");
expect(html.includes("50 payloads/parameter — quick validation pass"), "selected-level hint rendered");
expect(html.includes("2 selected, ≈ 8 min total"), "sequential duration estimate for 2 categories at minimal");
expect(!html.includes("WAF bypass always runs"), "waf_bypass note hidden until selected");
expect(html.includes("Only scan targets you own"), "authorization disclaimer kept");
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
