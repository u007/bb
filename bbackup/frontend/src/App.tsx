import React, { useState, useEffect } from 'react';
import './App.css';
import { EventsOn, EventsOff, OpenDirectoryDialog } from '../wailsjs/runtime';
import { App } from '../wailsjs/go/main/App'; // Assuming the Go App struct is in main package

// Define the shape of the BackupProgress object
interface BackupProgress {
    totalFiles: number;
    filesProcessed: number;
    currentFile: string;
    bytesTransferred: number;
    totalBytes: number;
    status: string;
    error: string;
}

function BackupApp() {
    const [sourcePaths, setSourcePaths] = useState<string[]>([]);
    const [destinationPath, setDestinationPath] = useState<string>('');
    const [ignorePatterns, setIgnorePatterns] = useState<string[]>([]);
    const [selectedSourceIndex, setSelectedSourceIndex] = useState<number | null>(null);
    const [selectedIgnoreIndex, setSelectedIgnoreIndex] = useState<number | null>(null);
    const [backupStatus, setBackupStatus] = useState<string>('Idle');
    const [logOutput, setLogOutput] = useState<string[]>([]);
    const [isProcessing, setIsProcessing] = useState<boolean>(false); // To disable buttons during backup
    const [progress, setProgress] = useState<BackupProgress | null>(null); // State for detailed progress

    // Load initial data and set up event listeners
    useEffect(() => {
        // Load suggested paths from Go backend
        App.GetSuggestedBackupPaths().then(paths => {
            setSourcePaths(paths);
        }).catch(err => {
            console.error("Error getting suggested paths:", err);
            addLog(`Error loading suggested paths: ${err}`);
        });

        // Load destination path from local storage
        const savedDestination = localStorage.getItem('backupDestinationPath');
        if (savedDestination) {
            setDestinationPath(savedDestination);
        }

        // Set up event listeners for logging and status updates from Go
        EventsOn('app:log', (message: string) => {
            addLog(message);
        });

        EventsOn('app:backup:status', (status: string) => {
            setBackupStatus(status);
            if (status === 'Completed' || status === 'Failed' || status === 'Cancelled') {
                setIsProcessing(false);
                // Optionally clear progress or reset
                setProgress(null);
            }
        });

        // Listener for detailed backup progress
        EventsOn('app:backup:progress', (jsonProgress: string) => {
            try {
                const parsedProgress: BackupProgress = JSON.parse(jsonProgress);
                setProgress(parsedProgress);
                // Also add to log for history
                addLog(`Status: ${parsedProgress.status} - ${parsedProgress.filesProcessed}/${parsedProgress.totalFiles} files, current: ${parsedProgress.currentFile}`);
                if (parsedProgress.error) {
                    addLog(`Progress Error: ${parsedProgress.error}`);
                }
            } catch (e) {
                addLog(`Error parsing progress update: ${e}`);
                console.error("Error parsing progress update:", e, jsonProgress);
            }
        });


        // Cleanup event listeners on component unmount
        return () => {
            EventsOff('app:log');
            EventsOff('app:backup:status');
            EventsOff('app:backup:progress');
        };
    }, []); // Empty dependency array means this runs once on mount

    const addLog = (message: string) => {
        setLogOutput(prev => [...prev, `[${new Date().toLocaleString()}] ${message}`]);
    };

    const handleAddSourcePath = async () => {
        const selectedDir = await OpenDirectoryDialog();
        if (selectedDir && !sourcePaths.includes(selectedDir)) {
            setSourcePaths(prev => [...prev, selectedDir]);
        }
    };

    const handleRemoveSourcePath = () => {
        if (selectedSourceIndex !== null) {
            const newSourcePaths = sourcePaths.filter((_, index) => index !== selectedSourceIndex);
            setSourcePaths(newSourcePaths);
            setSelectedSourceIndex(null);
        } else {
            addLog('Please select a source path to remove.');
        }
    };

    const handleAddIgnorePattern = () => {
        const pattern = prompt("Enter an ignore pattern (e.g., 'node_modules', '*.log'):");
        if (pattern && !ignorePatterns.includes(pattern)) {
            setIgnorePatterns(prev => [...prev, pattern]);
        }
    };

    const handleRemoveIgnorePattern = () => {
        if (selectedIgnoreIndex !== null) {
            const newIgnorePatterns = ignorePatterns.filter((_, index) => index !== selectedIgnoreIndex);
            setIgnorePatterns(newIgnorePatterns);
            setSelectedIgnoreIndex(null);
        } else {
            addLog('Please select an ignore pattern to remove.');
        }
    };
    
    const handleProposeIgnores = () => {
        addLog("Proposing default ignore patterns...");
        App.GetSuggestedIgnorePatterns().then(proposed => {
            setIgnorePatterns(prev => [...new Set([...prev, ...proposed])]); // Use a Set to avoid duplicates
        }).catch(err => {
            console.error("Error getting suggested ignore patterns:", err);
            addLog(`Error loading suggested ignore patterns: ${err}`);
        });
    };

    const handleSelectDestinationPath = async () => {
        const selectedDir = await OpenDirectoryDialog();
        if (selectedDir) {
            setDestinationPath(selectedDir);
            localStorage.setItem('backupDestinationPath', selectedDir); // Persist
        }
    };

    const handleStartBackup = () => {
        if (!destinationPath) {
            addLog('Error: Backup destination is not set.');
            return;
        }
        if (sourcePaths.length === 0) {
            addLog('Error: No source paths selected.');
            return;
        }

        setIsProcessing(true);
        setBackupStatus('Backup in progress...');
        addLog('Initiating backup...');
        // Reset progress state for a new backup
        setProgress(null);
        App.StartBackup(destinationPath, sourcePaths, ignorePatterns).catch(err => {
            console.error("Error initiating backup:", err);
            addLog(`Error initiating backup: ${err}`);
            setIsProcessing(false);
            setBackupStatus('Failed');
        });
    };

    return (
        <div id="app-container">
            <h1>Cross-Platform Backup</h1>

            <section className="section-container">
                <h2>Source Directories</h2>
                <div className="list-container">
                    {sourcePaths.length === 0 ? (
                        <p>No source directories added yet. Click 'Add Source' to begin.</p>
                    ) : (
                        <ul>
                            {sourcePaths.map((path, index) => (
                                <li
                                    key={path} // Using path as key is usually safe for unique paths
                                    className={selectedSourceIndex === index ? 'selected' : ''}
                                    onClick={() => setSelectedSourceIndex(index)}
                                >
                                    {path}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className="button-group">
                    <button onClick={handleAddSourcePath} disabled={isProcessing}>Add Source</button>
                    <button onClick={handleRemoveSourcePath} disabled={selectedSourceIndex === null || isProcessing}>Remove Selected</button>
                </div>
            </section>
            
            <section className="section-container">
                <h2>Ignored Paths & Patterns</h2>
                <div className="list-container">
                    {ignorePatterns.length === 0 ? (
                        <p>No ignore patterns defined. Click 'Propose Defaults' for common patterns.</p>
                    ) : (
                        <ul>
                            {ignorePatterns.map((pattern, index) => (
                                <li
                                    key={pattern}
                                    className={selectedIgnoreIndex === index ? 'selected' : ''}
                                    onClick={() => setSelectedIgnoreIndex(index)}
                                >
                                    {pattern}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className="button-group">
                    <button onClick={handleAddIgnorePattern} disabled={isProcessing}>Add Pattern</button>
                    <button onClick={handleRemoveIgnorePattern} disabled={selectedIgnoreIndex === null || isProcessing}>Remove Selected</button>
                    <button onClick={handleProposeIgnores} disabled={isProcessing}>Propose Defaults</button>
                </div>
            </section>

            <section className="section-container">
                <h2>Backup Destination</h2>
                <div className="input-group">
                    <input
                        type="text"
                        value={destinationPath || 'No destination selected'}
                        readOnly
                        className="destination-input"
                    />
                    <button onClick={handleSelectDestinationPath} disabled={isProcessing}>Select Destination</button>
                </div>
            </section>

            <section className="section-container">
                <h2>Backup Controls</h2>
                <button
                    onClick={handleStartBackup}
                    disabled={sourcePaths.length === 0 || !destinationPath || isProcessing}
                >
                    Start Backup
                </button>
                <p>
                    Current Status: <strong>{backupStatus}</strong>
                    {progress && (
                        <>
                            <br />Files: {progress.filesProcessed}/{progress.totalFiles}
                            {progress.currentFile && <br />}
                            {progress.currentFile && `Processing: ${progress.currentFile}`}
                            {progress.status && <br />}
                            {progress.status && `Detail: ${progress.status}`}
                            {progress.error && <br />}
                            {progress.error && `Error: ${progress.error}`}
                        </>
                    )}
                </p>
                <div className="log-output">
                    <h3>Log:</h3>
                    <pre>
                        {logOutput.map((line, index) => (
                            <div key={index}>{line}</div>
                        ))}
                    </pre>
                </div>
            </section>
        </div>
    );
}

export default BackupApp;
