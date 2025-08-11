"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

let toastListeners: ((toasts: Toast[]) => void)[] = [];
let toasts: Toast[] = [];

export function toast({ title, description, variant = "default" }: Omit<Toast, "id">) {
  const id = Math.random().toString(36).substr(2, 9);
  const newToast: Toast = { id, title, description, variant };
  
  toasts = [...toasts, newToast];
  toastListeners.forEach(listener => listener(toasts));
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    toastListeners.forEach(listener => listener(toasts));
  }, 5000);
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

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {localToasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            relative flex items-start gap-3 rounded-lg border p-4 pr-10 shadow-lg transition-all
            ${toast.variant === "destructive" 
              ? "border-red-500 bg-red-50 text-red-900" 
              : "border-gray-200 bg-white text-gray-900"
            }
          `}
        >
          <div className="flex-1">
            <p className="font-semibold">{toast.title}</p>
            {toast.description && (
              <p className="mt-1 text-sm opacity-90">{toast.description}</p>
            )}
          </div>
          <button
            onClick={() => removeToast(toast.id)}
            className="absolute right-2 top-2 rounded-md p-1 opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}