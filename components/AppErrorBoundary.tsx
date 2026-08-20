"use client";
import React from "react";

type State = { error: Error | null };

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error)
      return (
        <div style={{ padding: "3rem 2rem", textAlign: "center", fontFamily: "sans-serif" }}>
          <h2 style={{ color: "#b91c1c", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "#555", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#1d4ed8",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem 1.4rem",
              cursor: "pointer",
              fontSize: "0.9rem",
            }}
          >
            Reload app
          </button>
        </div>
      );
    return this.props.children;
  }
}
