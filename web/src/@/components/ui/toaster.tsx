"use client";

import { useEffect, useState } from "react";
import { X, AlertTriangle, Clock } from "lucide-react";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive" | "warning";
  /** Duration in ms before auto-dismiss (default: 5000) */
  duration?: number;
}

let toastListeners: ((toasts: Toast[]) => void)[] = [];
let toasts: Toast[] = [];

export function toast({ title, description, variant = "default", duration = 5000 }: Omit<Toast, "id">) {
  const id = Math.random().toString(36).substr(2, 9);
  const newToast: Toast = { id, title, description, variant, duration };

  toasts = [...toasts, newToast];
  toastListeners.forEach(listener => listener(toasts));

  // Auto-remove after duration
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    toastListeners.forEach(listener => listener(toasts));
  }, duration);
}

/**
 * Show a rate limit warning toast
 */
export function toastRateLimit(remaining: number, resetInSeconds?: number) {
  const description = resetInSeconds
    ? `Resets in ${Math.ceil(resetInSeconds)} seconds`
    : "Please slow down your requests";

  toast({
    title: `Rate limit: ${remaining} requests remaining`,
    description,
    variant: "warning",
    duration: 8000,
  });
}

export function Toaster() {
  const [localToasts, setLocalToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener = (newToasts: Toast[]) => setLocalToasts(newToasts);
    toastListeners.push(listener);
    
    return () => {
      toastListeners = toastListeners.filter(l => l !== listener);
    };
  }, []);

  const removeToast = (id: string) => {
    toasts = toasts.filter(t => t.id !== id);
    toastListeners.forEach(listener => listener(toasts));
  };

  if (localToasts.length === 0) return null;

  const getVariantStyles = (variant: Toast["variant"]) => {
    switch (variant) {
      case "destructive":
        return "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100";
      case "warning":
        return "border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
      default:
        return "border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100";
    }
  };

  const getIcon = (variant: Toast["variant"]) => {
    switch (variant) {
      case "warning":
        return <Clock className="h-5 w-5 text-amber-500" />;
      case "destructive":
        return <AlertTriangle className="h-5 w-5 text-red-500" />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {localToasts.map((t) => (
        <div
          key={t.id}
          className={`
            relative flex items-start gap-3 rounded-lg border p-4 pr-10 shadow-lg transition-all
            ${getVariantStyles(t.variant)}
          `}
        >
          {getIcon(t.variant)}
          <div className="flex-1">
            <p className="font-semibold">{t.title}</p>
            {t.description && (
              <p className="mt-1 text-sm opacity-90">{t.description}</p>
            )}
          </div>
          <button
            onClick={() => removeToast(t.id)}
            className="absolute right-2 top-2 rounded-md p-1 opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}