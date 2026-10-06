import { useState } from "react";

interface CalendarButtonProps {
  matchId: string;
  provider: string;
  initialSynced?: boolean;
}

export default function CalendarButton({
  matchId,
  provider,
  initialSynced = false,
}: CalendarButtonProps) {
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(initialSynced);
  const [error, setError] = useState<string | null>(null);

  const handleSync = async () => {
    if (synced || syncing) return;

    setSyncing(true);
    setError(null);

    try {
      const res = await fetch("/api/calendario/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });

      if (res.ok) {
        setSynced(true);
      } else {
        const data = await res.json();
        setError(data.error || "Error al sincronizar");
      }
    } catch (e) {
      console.error("Sync failed:", e);
      setError("Error de conexión");
    } finally {
      setSyncing(false);
    }
  };

  // Para Apple, mostrar botón de descarga
  if (provider === "apple") {
    return (
      <a
        href={`/api/calendario/download?matchId=${matchId}`}
        className="btn btn-primary btn-sm"
        download
      >
        <svg
          className="w-4 h-4 mr-1"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
        .ics
      </a>
    );
  }

  if (synced) {
    return (
      <span className="inline-flex items-center gap-1 text-green-600 text-sm font-medium">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
        En calendario
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="btn btn-primary btn-sm"
      >
        {syncing ? (
          <>
            <svg
              className="animate-spin w-4 h-4 mr-1"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Agregando...
          </>
        ) : (
          <>
            <svg
              className="w-4 h-4 mr-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            Agregar
          </>
        )}
      </button>
      {error && <span className="text-red-500 text-xs">{error}</span>}
    </div>
  );
}
