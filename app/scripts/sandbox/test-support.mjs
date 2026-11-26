// Shared by the sandbox deploy scripts' tests: this checkout's app folder (they import the lock and the name guard from
// it, as the deploy job does from main's) and invented sandbox values.
import { fileURLToPath } from 'node:url'
import { loadApp } from './teardown.mjs'

export const APP_DIR = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
export const app = await loadApp(APP_DIR)
export const ACCOUNT = '0123456789abcdef0123456789abcdef'
export const ZONE = 'zone.example.test'
