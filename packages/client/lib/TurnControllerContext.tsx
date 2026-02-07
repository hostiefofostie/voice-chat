import React, { createContext, useContext, useRef } from 'react';
import { TurnController } from './TurnController';

const TurnControllerCtx = createContext<TurnController | null>(null);

/**
 * Provides a singleton TurnController instance to the component tree.
 * The controller is created once and persists across re-renders.
 */
export function TurnControllerProvider({ children }: { children: React.ReactNode }) {
  const controllerRef = useRef<TurnController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new TurnController();
  }
  return (
    <TurnControllerCtx.Provider value={controllerRef.current}>
      {children}
    </TurnControllerCtx.Provider>
  );
}

/** Access the TurnController from any child component. */
export function useTurnController(): TurnController {
  const controller = useContext(TurnControllerCtx);
  if (!controller) {
    throw new Error('useTurnController must be used within a TurnControllerProvider');
  }
  return controller;
}
