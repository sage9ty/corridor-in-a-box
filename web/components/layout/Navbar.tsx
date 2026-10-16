import Link from "next/link";
import { Boxes } from "lucide-react";
import { GithubIcon } from "../icons/GithubIcon";
import { ThemeToggle } from "./ThemeToggle";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/payments", label: "Run a payment" },
  { href: "/docs", label: "Docs" },
];

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Boxes size={20} className="text-blue-600" />
          <span>corridor-in-a-box</span>
        </Link>

        <nav className="flex items-center gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-1.5 text-sm text-secondary-text transition-colors hover:bg-bg-subtle hover:text-primary-text"
            >
              {l.label}
            </Link>
          ))}
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="rounded-lg p-2 text-secondary-text transition-colors hover:bg-bg-subtle"
          >
            <GithubIcon size={18} />
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
