import { Icon } from "@/components/shared/icon"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"img">) {
  return (
    <Icon
      name="loader-circle"
      role="status"
      aria-label={"Loading"}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
