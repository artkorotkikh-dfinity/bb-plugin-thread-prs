import type { ReactElement, ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";

/** Portal styling stays scoped to this plugin; focus and Escape follow Radix. */
export function Tooltip({ children, content }: { children: ReactElement; content: ReactNode }) {
  const pluginId = experimental_usePluginId();
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-bb-plugin-root=""
            data-bb-plugin={pluginId}
            side="top"
            align="end"
            sideOffset={6}
            className="z-50 max-w-72 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
