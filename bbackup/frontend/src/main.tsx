import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import BackupApp from './App' // Changed from App to BackupApp

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <BackupApp/> {/* Changed from App to BackupApp */}
    </React.StrictMode>
)
