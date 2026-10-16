import { createContext, useContext } from 'react';

/**
 * True below AppLayout, which owns the app's one header. A page that is also shown with no shell
 * (the legal pages, prerendered for crawlers) draws its own header only when this is false.
 */
const AppShellContext = createContext(false);

export const AppShellProvider = AppShellContext.Provider;

export function useInAppShell(): boolean {
  return useContext(AppShellContext);
}
