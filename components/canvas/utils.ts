import { atom, Atom, Editor, WeakCache } from "tldraw";

/**
 * EditorAtom — reactive state scoped to a specific editor.
 * Re-exported from the tldraw Image pipeline starter so we can add the
 * node/port system without dragging in the rest of that starter's tooling.
 */
export class EditorAtom<T> {
  private states = new WeakCache<Editor, Atom<T>>();

  constructor(
    private name: string,
    private getInitialState: (editor: Editor) => T,
  ) {}

  getAtom(editor: Editor) {
    return this.states.get(editor, () => atom(this.name, this.getInitialState(editor)));
  }

  get(editor: Editor) {
    return this.getAtom(editor).get();
  }

  update(editor: Editor, update: (state: T) => T) {
    return this.getAtom(editor).update(update);
  }

  set(editor: Editor, state: T) {
    return this.getAtom(editor).set(state);
  }
}
