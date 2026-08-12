"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Editor } from "tldraw";

// ponytail: cross-component bridge from tool-ui cards (rendered inside
// the right-hand <Thread>) to the tldraw editor (which only mounts when
// canvas is open). Two contexts — `CanvasApi` for read access (cards),
// `CanvasRegister` for the mount-time setter (CanvasEditor). The split
// between read / write keeps consumer cards simple: they only need
// `useCanvas()`, which returns a no-op when the bridge is missing.
//
// A `no-op` default on the read side keeps tool-ui cards safe in
// narrow contexts where the provider hasn't mounted yet (non-canvas
// views, tests) — `ready: false, insertImage: () => false`.

export type InsertImageOpts = {
  url: string;
  // ponytail: defaults to 512×512. fal.ai returns square crops by
  // default; when the user requested a non-square aspect_ratio the
  // card passes the matching w/h so the inserted shape stays
  // proportional. We don't fetch the image to measure; trust the LLM
  // schema instead.
  w?: number;
  h?: number;
};

export type CanvasApi = {
  ready: boolean;
  insertImage: (opts: InsertImageOpts) => boolean;
};

const noopApi: CanvasApi = {
  ready: false,
  insertImage: () => false,
};

const CanvasContext = createContext<CanvasApi | null>(null);
const CanvasRegisterContext = createContext<(editor: Editor | null) => void>(() => {});

export function CanvasProvider({ children }: { children: ReactNode }) {
  // ponytail: store the editor in state, not a ref, so consumers
  // re-render when the editor flips null → live. The ref keeps the
  // latest value accessible from inside the memoized `insertImage`
  // closure without making it a dependency.
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  const insertImage = useCallback((opts: InsertImageOpts) => {
    const ed = editorRef.current;
    if (!ed) return false;
    const w = opts.w ?? 512;
    const h = opts.h ?? 512;
    // ponytail: drop the shape at the current viewport center in page
    // coords. `viewport.pageBounds.center` keeps the camera math out
    // of this file; on an empty canvas the center resolves to a sane
    // (x, y) inside the visible area.
    const center = ed.getViewportPageBounds().center;
    // ponytail: `x` / `y` live on the shape itself, not on `props` —
    // BaseBoxShapeUtil derives geometry from the top-level position,
    // while `props` carries the box dimensions and the asset url.
    ed.createShape({
      type: "image",
      x: center.x - w / 2,
      y: center.y - h / 2,
      props: {
        url: opts.url,
        w,
        h,
      },
    });
    return true;
  }, []);

  return (
    <CanvasRegisterContext.Provider value={setEditor}>
      <CanvasContext.Provider value={{ ready: editor !== null, insertImage }}>
        {children}
      </CanvasContext.Provider>
    </CanvasRegisterContext.Provider>
  );
}

export function useCanvas(): CanvasApi {
  return useContext(CanvasContext) ?? noopApi;
}

export function useCanvasRegister(): (editor: Editor | null) => void {
  return useContext(CanvasRegisterContext);
}
