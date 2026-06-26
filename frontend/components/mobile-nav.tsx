"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";

const TABS = [
  { href: "/missions", label: "Missions" },
  { href: "/missions/available", label: "Catalogue" },
  { href: "/missions/create", label: "Créer" },
  { href: "/profile", label: "Profil" },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === "/missions") return pathname === "/missions";
  return pathname.startsWith(href);
}

export function MobileNav() {
  const pathname = usePathname();
  const { status } = useAuth();

  if (status !== "authenticated") return null;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 flex border-t bg-background md:hidden"
      aria-label="Navigation mobile"
    >
      {TABS.map(tab => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={isActive(tab.href, pathname) ? "page" : undefined}
          className={cn(
            "flex flex-1 items-center justify-center py-3 text-xs",
            isActive(tab.href, pathname)
              ? "font-medium text-foreground"
              : "text-muted-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
