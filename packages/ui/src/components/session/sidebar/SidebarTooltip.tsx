import React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

type SidebarTooltipPayload = {
  content: React.ReactNode;
  side: TooltipSide;
  sideOffset: number;
  className?: string;
};

type SidebarTooltipHandle = BaseTooltip.Handle<SidebarTooltipPayload>;

const SidebarTooltipContext = React.createContext<SidebarTooltipHandle | null>(null);

/**
 * One tooltip for every row of the sidebar list.
 *
 * A tooltip per control mounts a Base UI tooltip root with each row that
 * scrolls into view, several per row; with hundreds of projects expanded that
 * was a large share of the work of rendering a row. Under this host the rows
 * register as detached triggers and pass their content as the payload, so only
 * the trigger mounts per row.
 *
 * The touch sidebar leaves it disabled: its per-control tooltips carry the
 * long-press behaviour, which a detached trigger does not.
 */
export function SidebarTooltipHost({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [handle] = React.useState<SidebarTooltipHandle>(() => BaseTooltip.createHandle<SidebarTooltipPayload>());
  if (!enabled) return <>{children}</>;
  return (
    <SidebarTooltipContext.Provider value={handle}>
      {children}
      <BaseTooltip.Root handle={handle}>
        {({ payload }) => payload ? (
          <TooltipContent side={payload.side} sideOffset={payload.sideOffset} className={payload.className}>
            {payload.content}
          </TooltipContent>
        ) : null}
      </BaseTooltip.Root>
    </SidebarTooltipContext.Provider>
  );
}

/**
 * A tooltip on one sidebar control: the shared one under an enabled
 * `SidebarTooltipHost`, an ordinary tooltip anywhere else.
 */
export function SidebarTooltip({ content, side, sideOffset = 0, className, children }: {
  content: React.ReactNode;
  side: TooltipSide;
  sideOffset?: number;
  className?: string;
  children: React.ReactElement;
}) {
  const handle = React.useContext(SidebarTooltipContext);
  if (!content) return children;
  if (handle) {
    return <BaseTooltip.Trigger handle={handle} payload={{ content, side, sideOffset, className }} render={children} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} className={className}>{content}</TooltipContent>
    </Tooltip>
  );
}
