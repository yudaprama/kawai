---
name: Kawai
description: A calm, local-first workspace for specialized AI agents and durable context.
colors:
  primary: "#0052d9"
  primary-hover: "#266fe8"
  primary-light: "#e3ecff"
  page: "#f2f4f8"
  surface: "#ffffff"
  surface-secondary: "#f2f4f8"
  surface-secondary-hover: "#e9ecf1"
  text-primary: "rgba(0, 0, 0, 0.9)"
  text-secondary: "rgba(0, 0, 0, 0.7)"
  text-tertiary: "rgba(0, 0, 0, 0.5)"
  border: "#e6e9ef"
  border-secondary: "#e9ecf1"
  error: "#f64041"
  success: "#0cbf5b"
  warning: "#ff7800"
  dark-page: "#181818"
  dark-surface: "#202020"
  dark-secondary: "#2c2c2c"
  dark-border: "#383838"
  dark-primary: "#2174ff"
  dark-text-primary: "hsla(0, 0%, 100%, 0.9)"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.5"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0.08em"
  mono:
    fontFamily: "Consolas, Menlo, Monaco, Andale Mono, Ubuntu Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "20px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  active-nav:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
  prompt-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# Design System: Kawai

## Overview

**Creative North Star: "The Quiet Control Room"**

The current Kawai interface is an observed visual system, not a marketing skin: a restrained operational workspace where the conversation remains the primary instrument and agents, sessions, knowledge, and assets form a legible perimeter around it. Its calm comes from cool neutral surfaces, compact typography, low-contrast dividers, and a single confident blue for action and focus.

The design is desktop-first and information-dense, but it uses progressive disclosure to keep complexity manageable: the agent rail collapses, sessions can hide, context becomes an optional canvas, and mobile replaces sidebars with drawers. The visual language favors useful grouping over decoration. Rounded controls, soft tonal surfaces, and small monospace metadata make the product feel like a precise workbench rather than a promotional chatbot.

**Key Characteristics:**
- Conversation-first composition with utility surfaces around the center.
- Cool paper-grey page background and white layered panels.
- One blue action color used sparingly for active and primary states.
- Compact system typography with monospace metadata and labels.
- Progressive disclosure through collapsible rails, drawers, tabs, and archived sections.

## Colors

The palette is cool, quiet, and functional: blue carries action and orientation, while most of the interface is built from near-white, grey, and restrained semantic colors.

### Primary
- **Kawai Blue** (`#0052d9`): Primary actions, active navigation, focus rings, and the main orientation signal.
- **Kawai Blue Hover** (`#266fe8`): Hover and emphasis state for primary actions.
- **Blue Wash** (`#e3ecff`): Low-intensity active navigation and selected surface backgrounds.

### Neutral
- **Page Grey** (`#f2f4f8`): The application background behind panels and asset surfaces.
- **Panel White** (`#ffffff`): Cards, popovers, asset containers, and elevated content surfaces.
- **Soft Grey** (`#f2f4f8`): Secondary controls and quiet grouped surfaces.
- **Hover Grey** (`#e9ecf1`): Hover states for secondary surfaces and navigation rows.
- **Ink** (`rgba(0, 0, 0, 0.9)`): Primary text and high-importance content.
- **Graphite** (`rgba(0, 0, 0, 0.7)`): Secondary text and supporting descriptions.
- **Mist** (`rgba(0, 0, 0, 0.5)`): Tertiary text, labels, metadata, and placeholders.
- **Line** (`#e6e9ef`): Standard panel and control borders.
- **Soft Line** (`#e9ecf1`): Quiet dividers inside asset and list surfaces.

### Functional
- **Error Red** (`#f64041`): Destructive actions and actionable failure states.
- **Success Green** (`#0cbf5b`): Successful indexing and completed operations.
- **Warning Orange** (`#ff7800`): Warnings and attention-required states.

### Dark Theme
- **Night Page** (`#181818`): Dark application background.
- **Night Panel** (`#202020`): Dark cards and primary surfaces.
- **Night Secondary** (`#2c2c2c`): Secondary surfaces and hover grouping.
- **Night Line** (`#383838`): Dark-theme borders and dividers.
- **Night Blue** (`#2174ff`): Dark-theme primary action and active state.

### Named Rules

**The One Blue Rule.** Blue establishes action and location; do not turn every informational surface into a branded surface.

**The Tonal Layer Rule.** Prefer page grey, panel white, and soft grey layering before adding shadows or saturated decoration.

## Typography

**Display Font:** None. Kawai is an operational workspace, so it does not use oversized display typography.

**Body Font:** System UI stack (`-apple-system`, `BlinkMacSystemFont`, CJK system faces, `Helvetica Neue`, Arial).

**Label/Mono Font:** Consolas, Menlo, Monaco, Andale Mono, Ubuntu Mono for ids, compact metadata, and section labels.

**Character:** The system font stack is quiet, native, and broadly legible across the desktop-first target. Weight and spacing create hierarchy rather than a decorative typeface: 600 for titles, 500 for interactive names, 400 for body copy, and tracked uppercase labels for navigation grouping.

### Hierarchy
- **Title** (600, 16px, 24px): Asset page headings and compact panel titles.
- **Body** (400, 14px, approximately 1.5): Conversation-adjacent copy, descriptions, and general controls.
- **Compact body** (400, 12px, 20px): Dense panel rows, helper text, and Tea asset metadata.
- **Label** (400, 11px, 16px, tracked uppercase): Agents, Assets, Sessions, archive groups, and other navigation labels.
- **Mono metadata** (400, 12px, 20px): User ids, technical identifiers, and compact system annotations.

### Named Rules

**The Quiet Hierarchy Rule.** Use size changes sparingly; increase weight, spacing, and contrast before introducing another font size.

## Layout

Kawai uses a desktop-first three-pane shell: a left agent rail, a conversation center, and a right sessions panel. The agent rail is 210px expanded or 64px collapsed; the sessions panel is 240px. The conversation is fluid and should retain the strongest visual authority.

The context canvas is optional and agent-dependent. At wide desktop widths it shares the center as a capped reading pane; at medium widths it behaves as an overlay, and below the desktop breakpoint it becomes a drawer. Mobile hides the permanent rails and exposes Agents, Sessions, and Knowledge through header controls and modal drawers.

Spacing follows a compact 4px base rhythm, with common intervals at 8px, 12px, 16px, and 24px. Main content is generally capped near 768px (`max-w-2xl`) for readable chat and composer measure. Panel content uses tighter 8–12px rows, while asset pages use 16px padding and structured list/detail regions.

### Named Rules

**The Conversation Authority Rule.** Secondary panes may organize work, but they must not make the primary conversation unreadable at the widths the product supports.

**The Four-Pane Exception Rule.** Agents, conversation, sessions, and context may coexist only when the center retains a comfortable reading measure; otherwise context becomes a drawer or sessions hide.

## Elevation & Depth

The system is primarily tonal rather than shadow-led. Page grey separates white panels, soft grey identifies grouped controls, and thin borders establish structure. Shadows are restrained and reserved for popovers, drawers, overlays, and genuinely floating surfaces. Asset containers may use a very soft ambient shadow; the default state should remain calm and nearly flat.

### Shadow Vocabulary
- **Subtle panel shadow** (`0 1px 4px 0 rgba(0, 0, 0, 0.05)`): Asset list panels and small contained surfaces.
- **Raised utility shadow** (`0 2px 8px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05)`): Popovers and lightly elevated controls.
- **Drawer shadow** (`0 12px 32px -4px rgba(0, 0, 0, 0.12), 0 8px 20px -8px rgba(0, 0, 0, 0.08)`): Mobile drawers and medium-width context overlays.

### Named Rules

**The Flat-at-Rest Rule.** Surfaces are flat or softly layered at rest; elevation appears when a surface floats above the work or requires focus.

## Shapes

Kawai uses gently curved, compact geometry: 4px for small details, 6px for controls and panels, 8px for navigation rows and grouped cards, and full pills for prompt suggestions and file mentions. Borders are thin and quiet, never the primary decorative feature. Selected rows use a tonal blue wash rather than a thick accent edge.

The composer is the strongest rounded silhouette in the shell, using a broad pill-like input group. Dense utility controls stay closer to 6px corners so the interface retains an operational, tool-like character.

## Components

### Buttons
- **Character:** Compact, direct, and utility-first.
- **Shape:** 6px radius for standard buttons; icon buttons use the same compact family.
- **Primary:** Kawai Blue with white text, 36px standard height, and 16px horizontal padding.
- **Hover / Focus:** Darken or shift the blue on hover; use a visible 3px focus ring derived from the blue ring token.
- **Secondary / Ghost:** Use soft grey or transparent backgrounds; hover into the secondary grey surface rather than adding a new accent.
- **Destructive:** Error red with white text; reserve for irreversible actions and keep confirmation visible.

### Inputs / Fields
- **Style:** 36px minimum height, 6px radius, 12px horizontal padding, quiet border, transparent or panel background.
- **Focus:** Blue border plus a 3px low-opacity blue ring.
- **Error / Disabled:** Error border/ring for invalid fields; disabled fields reduce opacity and remove pointer interaction.
- **Search:** Compact 28px field in session navigation, with the search icon inset at the left.

### Chips
- **Style:** Full-pill silhouette, white or soft-grey surface, 12px horizontal padding, and compact 12px text.
- **State:** Prompt chips are quiet suggestions; file mention chips use the accent surface and include a clear remove affordance.

### Cards / Containers
- **Corner Style:** 6–8px radius, with 6px standard for asset containers.
- **Background:** White panels on page grey; soft grey for secondary grouping.
- **Shadow Strategy:** Use the subtle panel shadow only when the container needs separation; rely on tonal contrast first.
- **Border:** 1px quiet line for panel boundaries and input grouping.
- **Internal Padding:** 12px for dense rows, 16px for asset containers, 24px for major empty states.

### Navigation
- **Style:** Compact vertical rows with icon + label + optional subtitle. Expanded rail is 210px; collapsed rail is 64px.
- **Default:** Transparent or page-toned row with muted supporting text.
- **Hover:** Soft grey background.
- **Active:** Blue-wash background or primary blue for the most important active agent/asset state; use an icon container to preserve recognition when collapsed.
- **Mobile:** Replace persistent rails with modal drawers, backed by a dimmed scrim and Escape/backdrop dismissal.

### Conversation Composer
- **Character:** The main action surface should feel approachable and stable, not ornamental.
- **Shape:** Broad 3xl/pill-like input group with compact footer controls.
- **Behavior:** Keep near the bottom of the conversation, show attached knowledge mentions above the field, expose stop while streaming, and preserve speech/file affordances without competing with text entry.

## Do's and Don'ts

### Do:
- **Do** keep the conversation and composer visually dominant on desktop.
- **Do** use the blue token for action, focus, and orientation rather than decoration.
- **Do** layer page grey, white panels, and soft grey before reaching for shadows.
- **Do** preserve visible text labels or explicit accessible names for important controls.
- **Do** use `focus-visible` states and keep keyboard actions discoverable.
- **Do** use drawers and progressive disclosure when the shell would otherwise become cramped.
- **Do** keep technical metadata monospace and visually subordinate.

### Don't:
- **Don't** give every pane equal visual weight when the user is trying to read or write in the conversation.
- **Don't** use thick colored side borders as decorative tabs on rounded cards.
- **Don't** hide essential session actions from keyboard or touch users behind hover alone.
- **Don't** mix languages in labels, errors, confirmations, or empty states without an explicit locale strategy.
- **Don't** add gradients, decorative display typography, or saturated surfaces that compete with tool output.
- **Don't** introduce a new color when an existing semantic token can express the state.
- **Don't** treat titles/tooltips as a substitute for visible hierarchy where space permits.
