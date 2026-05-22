import { useEffect } from "react";
import { useStore } from "@/store";

let started = false;

/** Mount-only initializer. Idempotent across StrictMode double-invokes. */
export function useBootstrap(): void {
  const ready = useStore((s) => s.ready);
  const bootstrap = useStore((s) => s.bootstrap);

  useEffect(() => {
    if (started) return;
    started = true;
    void bootstrap();
  }, [bootstrap]);

  // Re-fetch agents periodically in case status changes are missed
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      // Status arrives via WS now, no polling needed for MVP
    }, 30_000);
    return () => clearInterval(id);
  }, [ready]);
}
