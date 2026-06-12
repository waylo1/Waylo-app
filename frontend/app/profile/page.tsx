"use client";

import { useAuth } from "@/lib/auth";
import { RequireAuth } from "@/components/require-auth";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const KYC_LABELS = {
  PENDING: "En attente",
  VERIFIED: "Vérifié",
  REJECTED: "Refusé",
} as const;

function ProfileContent() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Profil</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Email</span>
            <span>{user.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">KYC</span>
            <Badge variant={user.kycStatus === "VERIFIED" ? "default" : "outline"}>
              {KYC_LABELS[user.kycStatus]}
            </Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Membre depuis</span>
            <span>{new Date(user.createdAt).toLocaleDateString("fr-FR")}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileContent />
    </RequireAuth>
  );
}
