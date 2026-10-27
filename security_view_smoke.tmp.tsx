// Throwaway smoke: renderSecurityScan markup against the screenshot-shaped envelope.
import { renderToStaticMarkup } from "react-dom/server";
import { renderSecurityScan } from "/Users/yuda/ai-orchestration/kawai/frontend/src/components/ai-elements/tool-renderers/security.tsx";

const longEvidence = `Response: <html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 4555056764204781147<br><br><a href='javascript:void(0)'>Go back</a></body></html> — plus trailing detail to force the three-line clamp in any pane width.`;
const longRemediation = [
  "1. CRITICAL: Require state parameter in authorization requests",
  "2. Generate cryptographically random state values",
  "3. Validate state parameter in callback",
  "4. Bind state to user session",
  "5. Implement short expiration for state values",
  "6. Use single-use state tokens",
].join("\n");

const findings = [
  {
    vulnType: "WAF Bypass via Null Byte Injection",
    severity: "HIGH",
    confidence: "HIGH",
    url: "https://digihub.telkomsel.com/?file=%00<script>alert(1)</script>",
    parameter: "file",
    evidence: longEvidence,
    remediation:
      "1. Strip null bytes from input 2. Use binary-safe string functions 3. Validate entire input after decoding",
    cwe: "CWE-626",
    cvss: 8.1,
  },
  {
    vulnType: "OAuth Missing State Parameter Validation",
    severity: "HIGH",
    confidence: "MEDIUM",
    url: "https://digihub.telkomsel.com/oauth/authorize",
    parameter: "state",
    evidence: "Authorization request accepted without state parameter",
    remediation: longRemediation,
    cwe: "CWE-352",
    cvss: 8.1,
  },
  {
    vulnType: "OAuth Missing PKCE for Public Clients",
    description:
      "OAuth flow does not appear to require PKCE (Proof Key for Code Exchange). Public clients (mobile apps, SPAs) without PKCE are vulnerable to authorization code interception attacks.",
    severity: "HIGH",
    confidence: "LOW",
    url: "https://digihub.telkomsel.com/oauth/authorize",
    parameter: null,
    evidence: "Authorization succeeds without code_challenge parameter",
    remediation: "Enforce PKCE for all public clients.",
    cwe: "CWE-862",
    cvss: 0, // no score → must not render "CVSS 0.0"
  },
  // pad to 10 to trip MAX_FINDINGS (3 HIGH sort first, so 5 of these render, 2 overflow)
  ...Array.from({ length: 7 }, (_, i) => ({
    vulnType: `Info Leak ${i}`,
    severity: i === 0 ? "MEDIUM" : "INFO",
    confidence: "—",
    url: `https://digihub.telkomsel.com/x${i}`,
    parameter: null,
    evidence: null,
    remediation: "",
    cwe: "",
    cvss: 0,
  })),
];

const html = renderToStaticMarkup(
  renderSecurityScan(
    JSON.stringify({
      kind: "security_scan",
      target: "https://digihub.telkomsel.com/",
      findings,
      testsRun: 866,
      durationSeconds: 105.5,
      earlyTerminated: false,
      terminationReason: null,
    }),
  ),
);

const empty = renderToStaticMarkup(
  renderSecurityScan(
    JSON.stringify({
      kind: "security_scan",
      target: "https://x/",
      findings: [],
      testsRun: 12,
      durationSeconds: 3.2,
      earlyTerminated: false,
      terminationReason: null,
    }),
  ),
);

const expect = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
};

expect(html.includes("border-l-destructive"), "HIGH findings carry destructive left accent");
expect(html.includes("border-l-warning"), "MEDIUM accent class present");
expect(html.includes("border-l-border"), "LOW/INFO accent class present");
expect(html.includes("conf MEDIUM"), "confidence labeled as 'conf MEDIUM' (was bare, read as a second severity)");
expect(html.includes("CVSS 8.1"), "CVSS score rendered");
expect(!html.includes("CVSS 0.0"), "zero CVSS omitted (old code printed '0 ·' artifacts)");
expect(!html.includes(">—<"), "missing confidence (—) dropped from metadata line");
expect(html.includes(">evidence<"), "EVIDENCE slot label present");
expect(html.includes("authorization code interception"), "impact description (the 'why') rendered under the title");
expect(html.includes(">remediation<"), "REMEDIATION slot label present");
expect(html.includes("line-clamp-3"), "evidence clamped to 3 lines");
expect((html.match(/line-clamp-3/g) ?? []).length >= 2, "remediation clamped to 3 lines (was unbounded)");
expect(html.includes("whitespace-pre-line"), "numbered steps keep their newlines (HTML no longer flattens them)");
expect(html.includes("\n2. Generate cryptographically random state values"), "step 2 renders on its own line, not run-on");
expect(html.includes("flex-wrap"), "severity/metadata row wraps on narrow panes");
expect(html.includes("866"), "tests run metric kept");
expect((html.match(/Show more/g) ?? []).length === 0, "no expand button in SSR (appears after layout measures real overflow)");
expect((html.match(/Info Leak/g) ?? []).length === 5, "list capped: 3 HIGH + 5 of 7 pad findings render");
expect(html.includes("2 more findings"), "overflow footnote counts the 2 hidden findings");
expect(empty.includes("No findings"), "empty state footnote kept");
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
