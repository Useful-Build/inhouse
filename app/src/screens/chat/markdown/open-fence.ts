import { createContext } from 'react'

/** True while the text is streaming and ends inside an open fence: its last code block is still being written. */
export const OpenFenceContext = createContext(false)
