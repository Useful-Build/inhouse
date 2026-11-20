import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/theme'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installErrorReporting } from './report-error'

installErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
)
