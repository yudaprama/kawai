import { Icon } from "@/components/shared/icon";
import { useTheme } from "@/hooks/use-theme";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <Icon name="circle-check" className="size-4" />,
        info: <Icon name="info" className="size-4" />,
        warning: <Icon name="triangle-alert" className="size-4" />,
        error: <Icon name="octagon-x" className="size-4" />,
        loading: <Icon name="loader-circle" className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      // `offset`/`mobileOffset` are per-side: a single STRING applies to all
      // four sides, and sonner's ≤600px CSS derives the toast WIDTH from
      // `--mobile-offset-left` (`calc(100% - var(--mobile-offset-left) * 2)`)
      // and the container inset from `--mobile-offset-right`. A bottom-clearance
      // string there once collapsed every mobile toast to zero width — one
      // character per line, full-screen height. Bottom gets the composer
      // clearance; the other sides stay ordinary margins.
      offset={{ top: "1rem", right: "1rem", bottom: "1rem", left: "1rem" }}
      // kawai: below sonner's 600px mobile breakpoint the Workbench pins its
      // composer to the bottom of the canvas, so a bottom toast covers the
      // input (or hides under the IME). Raise the bottom offset clear of the
      // composer panel; left/right/top stay compact so the toast keeps its
      // width. (`mobileOffset` only applies at that breakpoint.)
      mobileOffset={{
        top: "calc(env(safe-area-inset-top, 0px) + 1rem)",
        right: "calc(env(safe-area-inset-right, 0px) + 1rem)",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 13rem)",
        left: "calc(env(safe-area-inset-left, 0px) + 1rem)",
      }}
      {...props}
    />
  );
};

export { Toaster };
