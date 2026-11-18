// The app's windows and menus open and close with no motion (and screenshots catch them fully drawn).
// shadcn's overlays animate with `animate-in` and `animate-out`, which a plain `animate-none` doesn't beat,
// so these use the important modifier. That is the only place the app uses `!` (see DESIGN_SYSTEM.md).

/** No open or close motion on a Radix overlay or content. */
export const NO_MOTION = 'data-[state=open]:animate-none! data-[state=closed]:animate-none!'
/** No close motion only (the chat menu closes without a fade after Rename, but fades in). */
export const NO_CLOSE_MOTION = 'data-[state=closed]:animate-none!'
