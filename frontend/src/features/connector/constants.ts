/**
 * Connector (Composio OAuth connect) app catalog — ported verbatim from the
 * web SPA's `web/src/lib/connector.ts`. `app` is the auth-config app key kept
 * for catalog identity; `toolkit` is the Composio toolkit slug the backend
 * speaks (`connector_connect` args, `Connection.app` in list results) and the
 * key callers use to match an existing connection. `category` drives the
 * Browse-apps filter chips on the Connections asset page.
 */

export const CONNECTOR_CATEGORIES = [
  "google",
  "microsoft",
  "communication",
  "productivity",
  "crm",
  "dev",
  "design",
] as const;

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export const CONNECTOR_APPS = [
  { app: "github-kawai", label: "GitHub", toolkit: "github", category: "dev" },
  { app: "gmail-kawai", label: "Gmail", toolkit: "gmail", category: "google" },
  { app: "googlecalendar-kawai", label: "Google Calendar", toolkit: "googlecalendar", category: "google" },

  { app: "googledrive-kawai", label: "Google Drive", toolkit: "googledrive", category: "google" },
  { app: "googledocs-kawai", label: "Google Docs", toolkit: "googledocs", category: "google" },
  { app: "googlebigquery-kawai", label: "Google BigQuery", toolkit: "googlebigquery", category: "google" },
  { app: "googleslides-kawai", label: "Google Slides", toolkit: "googleslides", category: "google" },
  { app: "googlesuper-kawai", label: "Google Super", toolkit: "googlesuper", category: "google" },
  { app: "google_analytics-kawai", label: "Google Analytics", toolkit: "google_analytics", category: "google" },
  { app: "googlephotos-kawai", label: "Google Photos", toolkit: "googlephotos", category: "google" },
  { app: "google_maps-kawai", label: "Google Maps", toolkit: "google_maps", category: "google" },

  { app: "googletasks-kawai", label: "Google Tasks", toolkit: "googletasks", category: "google" },
  { app: "googlemeet-kawai", label: "Google Meet", toolkit: "googlemeet", category: "google" },
  { app: "googleads-kawai", label: "Google Ads", toolkit: "googleads", category: "google" },
  { app: "google_classroom-kawai", label: "Google Classroom", toolkit: "google_classroom", category: "google" },
  {
    app: "google_search_console-kawai",
    label: "Google Search Console",
    toolkit: "google_search_console",
    category: "google",
  },
  { app: "googlesheets-kawai", label: "Google Sheets", toolkit: "googlesheets", category: "google" },
  { app: "microsoft_teams-kawai", label: "Microsoft Teams", toolkit: "microsoft_teams", category: "microsoft" },
  { app: "excel-kawai", label: "Microsoft Excel", toolkit: "excel", category: "microsoft" },
  { app: "one_drive-kawai", label: "OneDrive", toolkit: "one_drive", category: "microsoft" },
  { app: "outlook-kawai", label: "Outlook", toolkit: "outlook", category: "microsoft" },
  { app: "share_point-kawai", label: "SharePoint", toolkit: "share_point", category: "microsoft" },
  { app: "whatsapp-kawai", label: "WhatsApp", toolkit: "whatsapp", category: "communication" },
  { app: "discord-kawai", label: "Discord", toolkit: "discord", category: "communication" },
  { app: "discordbot-kawai", label: "Discordbot", toolkit: "discordbot", category: "communication" },
  { app: "linkedin-kawai", label: "LinkedIn", toolkit: "linkedin", category: "communication" },
  { app: "facebook-kawai", label: "Facebook", toolkit: "facebook", category: "communication" },
  { app: "instagram-kawai", label: "Instagram", toolkit: "instagram", category: "communication" },
  { app: "youtube-kawai", label: "YouTube", toolkit: "youtube", category: "communication" },
  { app: "zoho_mail-kawai", label: "Zoho Mail", toolkit: "zoho_mail", category: "communication" },
  { app: "mailchimp-kawai", label: "Mailchimp", toolkit: "mailchimp", category: "communication" },
  { app: "todoist-kawai", label: "Todoist", toolkit: "todoist", category: "productivity" },
  { app: "jira-kawai", label: "Jira", toolkit: "jira", category: "productivity" },
  { app: "miro-kawai", label: "Miro", toolkit: "miro", category: "productivity" },
  { app: "asana-kawai", label: "Asana", toolkit: "asana", category: "productivity" },
  { app: "eventbrite-kawai", label: "Eventbrite", toolkit: "eventbrite", category: "productivity" },
  { app: "calendly-kawai", label: "Calendly", toolkit: "calendly", category: "productivity" },
  { app: "notion-kawai", label: "Notion", toolkit: "notion", category: "productivity" },
  { app: "box-kawai", label: "Box", toolkit: "box", category: "productivity" },
  { app: "hubspot-kawai", label: "HubSpot", toolkit: "hubspot", category: "crm" },
  { app: "salesforce-kawai", label: "Salesforce", toolkit: "salesforce", category: "crm" },
  { app: "zendesk-kawai", label: "Zendesk", toolkit: "zendesk", category: "crm" },
  { app: "greenhouse-kawai", label: "Greenhouse", toolkit: "greenhouse", category: "crm" },
  { app: "square-kawai", label: "Square", toolkit: "square", category: "crm" },
  { app: "supabase-kawai", label: "Supabase", toolkit: "supabase", category: "dev" },
  { app: "clickhouse-kawai", label: "ClickHouse", toolkit: "clickhouse", category: "dev" },
  { app: "sentry-kawai", label: "Sentry", toolkit: "sentry", category: "dev" },
  { app: "contentful-kawai", label: "Contentful", toolkit: "contentful", category: "dev" },
  { app: "figma-kawai", label: "Figma", toolkit: "figma", category: "design" },
  { app: "canva-kawai", label: "Canva", toolkit: "canva", category: "design" },
] as const;

export type ConnectorApp = (typeof CONNECTOR_APPS)[number];

/** One row of `connector_list_connections` (Rust `Connection`, camelCase serde). */
export interface Connection {
  id: string;
  /** Composio toolkit slug, e.g. "gmail". */
  app: string;
  /** "ACTIVE" | "INITIALIZING" | "FAILED" | "EXPIRED" | "DELETED". */
  status: string;
  createdAt?: string;
}
