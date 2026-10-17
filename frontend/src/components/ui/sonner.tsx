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
      // `offset` accepts a CSS length, so fold the safe-area inset in:
      // otherwise toasts land under the Android gesture-nav strip.
      offset="calc(env(safe-area-inset-bottom, 0px) + 1rem)"
      mobileOffset="calc(env(safe-area-inset-bottom, 0px) + 1rem)"
      {...props}
    />
  );
};

export { Toaster };
