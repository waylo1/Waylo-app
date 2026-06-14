"use client";

import { useEffect } from "react";
import { captureError } from "@/lib/error-reporting";

// Error boundary GLOBALE : intercepte les plantages de rendu du RootLayout.
// Remplace la racine → doit définir ses propres <html>/<body> (styles inline,
// les globaux pouvant être indisponibles ici).
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    captureError(error, { source: "global-error", digest: error.digest });
  }, [error]);

  return (
    <html lang="fr">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>
          Une erreur est survenue.
        </h2>
        <p style={{ color: "#666", marginTop: "0.5rem" }}>
          L&apos;incident a été signalé. Vous pouvez réessayer.
        </p>
        <button
          onClick={() => unstable_retry()}
          style={{
            marginTop: "1rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid #ccc",
            cursor: "pointer",
          }}
        >
          Réessayer
        </button>
      </body>
    </html>
  );
}
