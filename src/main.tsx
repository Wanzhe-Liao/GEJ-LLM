import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { logApiDiagnostics } from './utils/apiConfig'

// Run API diagnostics on startup
if (import.meta.env.VITE_DEBUG === 'true') {
  console.log('🔍 Running API configuration diagnostics...')
  logApiDiagnostics()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
