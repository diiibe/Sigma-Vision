import { useState } from "react";

const EXPORT_OPTIONS = [
  { id: "counting", label: "Counting Events", endpoint: "/api/export/counting" },
  { id: "density", label: "Density Snapshots", endpoint: "/api/export/density" },
  { id: "security", label: "Security Events", endpoint: "/api/export/security" },
];

export function ExportMenu() {
  const [open, setOpen] = useState(false);

  return (
    <div className="export-menu">
      <button
        type="button"
        className="export-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="export-data-panel"
      >
        Export Data
      </button>

      {open && (
        <div
          id="export-data-panel"
          className="export-menu__dropdown"
          aria-label="Export data controls"
        >
          <div className="export-menu__header">
            <p className="export-menu__label">Export data</p>
            <button
              type="button"
              className="export-menu__close"
              onClick={() => setOpen(false)}
              aria-label="Close export controls"
            >
              ×
            </button>
          </div>
          {EXPORT_OPTIONS.map((opt) => (
            <a
              key={opt.id}
              className="export-menu__link"
              href={opt.endpoint}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              {opt.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
