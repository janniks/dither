import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NavLogo } from "./nav-logo";

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <NavLogo />,
    },
    // see https://fumadocs.dev/docs/ui/navigation/links
    links: [],
  };
}
