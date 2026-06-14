"use client";

import { useEffect } from "react";
import { captureError } from "@/lib/error-reporting";
import { Button } from "@/components/ui/button";

// Error boundary de segment : intercepte les plantages de rendu sous le
// RootLayout (navbar conservée). Reporte l'erreur puis propose un retry.
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    captureError(error, { source: "route-error", digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto max-w-lg space-y-3 py-8 text-center">
      <h2 className="text-lg font-semibold">Une erreur est survenue.</h2>
      <p className="text-sm text-muted-foreground">
        L&apos;incident a été signalé. Vous pouvez réessayer.
      </p>
      <Button onClick={() => unstable_retry()}>Réessayer</Button>
    </div>
  );
}
