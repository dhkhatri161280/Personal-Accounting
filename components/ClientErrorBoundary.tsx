"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ClientErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  resetWorkspace = async () => {
    try {
      localStorage.removeItem("fintech-by-dk-generic-erp-v2");
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
    } catch {}
    window.location.href = "/?resetgeneric=1";
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="dk-lock">
        <section className="dk-unlock-card">
          <b className="dk-brand-mark">
            <span>D</span>
            <span>K</span>
          </b>
          <small>FINTECH BY DK</small>
          <h1>Workspace recovery</h1>
          <p>
            The saved workspace could not open cleanly. Start a clean workspace and the page will
            load again.
          </p>
          <button className="dk-primary" onClick={this.resetWorkspace}>
            Start Clean Workspace
          </button>
        </section>
      </main>
    );
  }
}
