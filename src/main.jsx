import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AgentProvider } from './agent/AgentProvider'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AgentProvider>
      <App />
    </AgentProvider>
  </React.StrictMode>,
)
