// PR 7, Pages and windows, at 1440: pause a tool and see its Read and Draft change; every page on First day and while
// Loading shows a real state; a Run now lands in a routine's Last runs with its result. The phone twin is
// pages-polish-phone.spec.ts, and the checks are in pages-polish-checks.ts.
import { test } from '@playwright/test'
import { pagesPolish } from './pages-polish-checks.js'

pagesPolish(test, 'desktop')
