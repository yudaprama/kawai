const SVG_OPEN_TAG_RE = /(<svg\b)/;

/**
 * Ensure the SVG root element declares the xlink namespace when the document
 * contains xlink-prefixed attributes (e.g. `xlink:href` used by Mermaid in
 * C4 and sequence diagrams).  Without the declaration the SVG is not valid
 * XML: browsers refuse to load it as an image, causing PNG export to fail
 * silently.
 *
 * The fix mirrors the approach used for other Mermaid SVG normalisation
 * issues: detect the problem via a lightweight string check and patch the
 * root `<svg>` opening tag in-place before any further processing.
 *
 * Falls back to the original string when the namespace is already present or
 * when xlink-prefixed attributes are absent.
 */
export const addXlinkNamespaceIfMissing = (svgString: string): string => {
  if (!svgString.includes("xlink:") || svgString.includes("xmlns:xlink")) {
    return svgString;
  }
  return svgString.replace(
    SVG_OPEN_TAG_RE,
    '$1 xmlns:xlink="http://www.w3.org/1999/xlink"'
  );
};

/**
 * Mermaid render output may be HTML-serialized. Serialize the SVG node as XML
 * before downloading so embedded HTML like <br> becomes valid SVG markup.
 */
export const serializeSvgForDownload = (svgString: string): string => {
  if (
    typeof DOMParser === "undefined" ||
    typeof XMLSerializer === "undefined"
  ) {
    return svgString;
  }

  const doc = new DOMParser().parseFromString(svgString, "text/html");
  const svg = doc.querySelector("svg");

  if (!svg) {
    return svgString;
  }

  return new XMLSerializer().serializeToString(svg);
};

/**
 * Ensure SVG string has required XML namespaces for canvas rendering
 */
function normalizeSvg(svg: string): string {
  if (svg.includes("xlink:href") && !svg.includes("xmlns:xlink")) {
    return svg.replace("<svg", '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return svg;
}

/**
 * Convert SVG string to PNG blob for export
 */
export const svgToPngBlob = (
  svgString: string,
  options?: { scale?: number }
): Promise<Blob> => {
  const scale = options?.scale ?? 5;

  return new Promise((resolve, reject) => {
    const normalized = normalizeSvg(svgString);

    const encoded =
      "data:image/svg+xml;base64," +
      btoa(unescape(encodeURIComponent(normalized)));

    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      const canvas = document.createElement("canvas");
      const w = img.width * scale;
      const h = img.height * scale;

      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject(new Error("Failed to create 2D canvas context for PNG export"));
        return;
      }

      // Do NOT draw a background → transparency preserved
      // ctx.clearRect(0, 0, w, h);

      ctx.drawImage(img, 0, 0, w, h);

      // Export PNG (lossless, keeps transparency)
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Failed to create PNG blob"));
          return;
        }
        resolve(blob);
      }, "image/png");
    };

    img.onerror = () => reject(new Error("Failed to load SVG image"));
    img.src = encoded;
  });
};

/**
 * Re-serialize an SVG string as valid XML using the browser's DOMParser and
 * XMLSerializer. Mermaid renders diagrams via innerHTML, which can produce
 * HTML-normalized elements such as `<br>` (non-self-closing) that are invalid
 * inside SVG/XML. XMLSerializer converts them back to self-closing form so the
 * saved file is valid and can be loaded as an image.
 *
 * Falls back to the original string when running outside a browser or if
 * parsing fails.
 */
export const sanitizeSvgForExport = (svgString: string): string => {
  if (typeof document === "undefined") {
    return svgString;
  }
  try {
    const container = document.createElement("div");
    container.innerHTML = svgString;
    const svgElement = container.querySelector("svg");
    if (!svgElement) {
      return svgString;
    }
    return new XMLSerializer().serializeToString(svgElement);
  } catch {
    return svgString;
  }
};

/**
 * Generate a unique ID for a Mermaid chart based on its content hash and timestamp
 */
export const generateMermaidChartId = (chart: string): string => {
  const chartHash = chart.split("").reduce((acc, char) => {
    // biome-ignore lint/suspicious/noBitwiseOperators: "Required for Mermaid"
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);
  return `mermaid-${Math.abs(chartHash)}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};
