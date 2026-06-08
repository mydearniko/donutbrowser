"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { getCurrentOS } from "@/lib/browser-utils";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const handles: Array<{
  direction: ResizeDirection;
  className: string;
}> = [
  {
    direction: "North",
    className: "top-0 left-3 right-[100px] h-1.5 cursor-ns-resize",
  },
  {
    direction: "South",
    className: "bottom-0 left-3 right-3 h-1.5 cursor-ns-resize",
  },
  {
    direction: "East",
    className: "right-0 top-11 bottom-3 w-1.5 cursor-ew-resize",
  },
  {
    direction: "West",
    className: "left-0 top-3 bottom-3 w-1.5 cursor-ew-resize",
  },
  {
    direction: "NorthEast",
    className: "top-0 right-[88px] size-3 cursor-nesw-resize",
  },
  {
    direction: "NorthWest",
    className: "top-0 left-0 size-3 cursor-nwse-resize",
  },
  {
    direction: "SouthEast",
    className: "bottom-0 right-0 size-3 cursor-nwse-resize",
  },
  {
    direction: "SouthWest",
    className: "bottom-0 left-0 size-3 cursor-nesw-resize",
  },
];

export function WindowResizeHandles() {
  const [isWindows, setIsWindows] = useState(false);

  useEffect(() => {
    setIsWindows(getCurrentOS() === "windows");
  }, []);

  if (!isWindows) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-[60] pointer-events-none"
    >
      {handles.map(({ direction, className }) => (
        <div
          key={direction}
          className={`absolute pointer-events-auto ${className}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
    </div>
  );
}
