"use client";

import { useState, useCallback, useRef, useEffect } from "react";

interface UseUndoRedoOptions<T> {
  /** Maximum history size (default: 50) */
  maxHistory?: number;
  /** Debounce delay for grouping rapid changes (default: 300ms) */
  debounceMs?: number;
  /** Initial state */
  initialState: T;
  /** Equality function to compare states */
  isEqual?: (a: T, b: T) => boolean;
}

interface UseUndoRedoReturn<T> {
  /** Current state */
  state: T;
  /** Set new state (adds to history) */
  setState: (newState: T | ((prev: T) => T)) => void;
  /** Undo to previous state */
  undo: () => void;
  /** Redo to next state */
  redo: () => void;
  /** Can undo? */
  canUndo: boolean;
  /** Can redo? */
  canRedo: boolean;
  /** Reset history and set new initial state */
  reset: (newState: T) => void;
  /** Clear history but keep current state */
  clearHistory: () => void;
  /** Number of states in undo stack */
  undoCount: number;
  /** Number of states in redo stack */
  redoCount: number;
}

function defaultIsEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useUndoRedo<T>({
  maxHistory = 50,
  debounceMs = 300,
  initialState,
  isEqual = defaultIsEqual,
}: UseUndoRedoOptions<T>): UseUndoRedoReturn<T> {
  const [state, setStateInternal] = useState<T>(initialState);
  const [undoStack, setUndoStack] = useState<T[]>([]);
  const [redoStack, setRedoStack] = useState<T[]>([]);

  // Refs for debouncing
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingStateRef = useRef<T | null>(null);
  const lastSavedStateRef = useRef<T>(initialState);

  // Clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Commit pending state to history
  const commitToHistory = useCallback(
    (previousState: T, newState: T) => {
      if (isEqual(previousState, newState)) return;

      setUndoStack((prev) => {
        const newStack = [...prev, previousState];
        // Trim to max history
        if (newStack.length > maxHistory) {
          return newStack.slice(newStack.length - maxHistory);
        }
        return newStack;
      });

      // Clear redo stack on new change
      setRedoStack([]);
      lastSavedStateRef.current = newState;
    },
    [isEqual, maxHistory]
  );

  // Set state with history tracking
  const setState = useCallback(
    (newState: T | ((prev: T) => T)) => {
      setStateInternal((currentState) => {
        const resolvedState =
          typeof newState === "function"
            ? (newState as (prev: T) => T)(currentState)
            : newState;

        // Skip if state hasn't changed
        if (isEqual(currentState, resolvedState)) {
          return currentState;
        }

        // Store pending state
        pendingStateRef.current = resolvedState;

        // Clear existing debounce timer
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }

        // Set up debounce for history commit
        debounceTimerRef.current = setTimeout(() => {
          if (pendingStateRef.current !== null) {
            commitToHistory(lastSavedStateRef.current, pendingStateRef.current);
            pendingStateRef.current = null;
          }
        }, debounceMs);

        return resolvedState;
      });
    },
    [commitToHistory, debounceMs, isEqual]
  );

  // Undo
  const undo = useCallback(() => {
    // Flush any pending changes first
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (pendingStateRef.current !== null) {
      commitToHistory(lastSavedStateRef.current, pendingStateRef.current);
      pendingStateRef.current = null;
    }

    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;

      const newUndo = [...prevUndo];
      const previousState = newUndo.pop()!;

      setRedoStack((prevRedo) => [...prevRedo, state]);
      setStateInternal(previousState);
      lastSavedStateRef.current = previousState;

      return newUndo;
    });
  }, [state, commitToHistory]);

  // Redo
  const redo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;

      const newRedo = [...prevRedo];
      const nextState = newRedo.pop()!;

      setUndoStack((prevUndo) => [...prevUndo, state]);
      setStateInternal(nextState);
      lastSavedStateRef.current = nextState;

      return newRedo;
    });
  }, [state]);

  // Reset
  const reset = useCallback((newState: T) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingStateRef.current = null;
    lastSavedStateRef.current = newState;
    setStateInternal(newState);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  // Clear history
  const clearHistory = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingStateRef.current = null;
    lastSavedStateRef.current = state;
    setUndoStack([]);
    setRedoStack([]);
  }, [state]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd/Ctrl + Z (undo) or Cmd/Ctrl + Shift + Z (redo)
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
      // Also support Cmd/Ctrl + Y for redo
      if ((e.metaKey || e.ctrlKey) && e.key === "y") {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  return {
    state,
    setState,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    reset,
    clearHistory,
    undoCount: undoStack.length,
    redoCount: redoStack.length,
  };
}
