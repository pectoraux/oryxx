"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, LogOut, ShieldCheck } from "lucide-react";
import { roleLabel } from "@/lib/auth/options";

export function UserMenu({
  email,
  name,
  role,
  onOpenAdmin,
  isAdmin,
}: {
  email: string;
  name?: string | null;
  role: string;
  onOpenAdmin: () => void;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initials = (name || email).slice(0, 2).toUpperCase();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-1.5 px-2">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-emerald-600 text-[11px] text-white">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-xs font-medium sm:inline">
            {name || email.split("@")[0]}
          </span>
          <Badge variant="outline" className="hidden text-[10px] lg:inline">
            {roleLabel(role)}
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">
          <div className="font-medium">{email}</div>
          <div className="text-[10px] text-muted-foreground">{roleLabel(role)}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isAdmin && (
          <DropdownMenuItem onClick={() => { onOpenAdmin(); setOpen(false); }}>
            <ShieldCheck className="mr-2 h-3.5 w-3.5" />
            Manage waitlist
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => signOut({ callbackUrl: "/" })}
          className="text-rose-600 focus:text-rose-700"
        >
          <LogOut className="mr-2 h-3.5 w-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
