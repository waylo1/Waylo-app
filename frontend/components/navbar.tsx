"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "/missions", label: "Mes missions" },
  { href: "/missions/available", label: "Catalogue" },
  { href: "/profile", label: "Profil" },
] as const;

export function Navbar() {
  const pathname = usePathname();
  const { status, user, signOut } = useAuth();

  return (
    <header className="border-b">
      <nav className="mx-auto flex h-14 max-w-4xl items-center gap-6 px-4">
        <Link href="/missions" className="font-semibold tracking-tight">
          Waylo
        </Link>
        {LINKS.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "text-sm text-muted-foreground hover:text-foreground",
              pathname === link.href && "text-foreground font-medium",
            )}
          >
            {link.label}
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {status === "authenticated" && user ? (
            <>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {user.email}
              </span>
              <Button variant="outline" size="sm" onClick={signOut}>
                Déconnexion
              </Button>
            </>
          ) : status === "anonymous" ? (
            <Button size="sm" render={<Link href="/login">Connexion</Link>} />
          ) : null}
        </div>
      </nav>
    </header>
  );
}
