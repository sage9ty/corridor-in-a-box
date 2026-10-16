"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { docs } from "@/lib/docs";

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-secondary-text">
        Documentation
      </div>
      {docs.map((d) => {
        const href = `/docs/${d.slug}`;
        const active = pathname === href;
        return (
          <Link
            key={d.slug}
            href={href}
            className={clsx(
              "rounded-lg px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-bg-subtle font-medium text-blue-600"
                : "text-secondary-text hover:bg-bg-subtle hover:text-primary-text",
            )}
          >
            {d.title}
          </Link>
        );
      })}
    </nav>
  );
}
