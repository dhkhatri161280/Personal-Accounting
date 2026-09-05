import { createTheme } from "@mui/material/styles";
import type {} from "@mui/x-data-grid/themeAugmentation";

// Maps MUI's defaults onto this app's existing hand-rolled palette (app/globals.css) so
// components like DataGrid don't look like a different product bolted on.
export const appMuiTheme = createTheme({
  palette: {
    primary: { main: "#2f6fed" },
    text: { primary: "#0f1b2d", secondary: "#748197" },
    divider: "#dfe5ee",
    background: { paper: "#ffffff" },
  },
  typography: {
    fontFamily: "var(--font-sans), Arial, sans-serif",
    fontSize: 13,
  },
  shape: { borderRadius: 10 },
  components: {
    MuiDataGrid: {
      styleOverrides: {
        root: {
          border: "1px solid #e4e9f1",
          borderRadius: 14,
          fontSize: 13,
        },
        columnHeaders: {
          background: "#f8fafe",
          color: "#748197",
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        },
        cell: {
          borderColor: "#dfe5ee",
        },
        footerContainer: {
          borderColor: "#dfe5ee",
        },
      },
    },
  },
});
