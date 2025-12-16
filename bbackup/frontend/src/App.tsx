import React, { useState, useEffect } from 'react';
import './App.css';
import { EventsOn, EventsOff } from '../wailsjs/runtime';
import * as App from '../wailsjs/go/main/App'; // Import all functions from App namespace

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

// Define backup configuration interface
interface BackupConfig {
    id: string;
    name: string;
    sourcePaths: string[];
    destinationPath: string;
    ignorePatterns: string[];
    schedule: string; // 'manual', 'hourly', 'daily', 'weekly', 'monthly'
    enabled: boolean;
    lastBackup?: string;
    nextBackup?: string;
}

function BackupApp() {
    const [backups, setBackups] = useState<BackupConfig[]>([]);
    const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
    const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
    const [showEditForm, setShowEditForm] = useState<boolean>(false);
    const [editingBackup, setEditingBackup] = useState<BackupConfig | null>(null);
    
    // Form state for creating/editing backups
    const [formBackupName, setFormBackupName] = useState<string>('');
    const [formSourcePaths, setFormSourcePaths] = useState<string[]>([]);
    const [formDestinationPath, setFormDestinationPath] = useState<string>('');
    const [formIgnorePatterns, setFormIgnorePatterns] = useState<string[]>([]);
    const [formSchedule, setFormSchedule] = useState<string>('manual');
    
    const [selectedSourceIndex, setSelectedSourceIndex] = useState<number | null>(null);
    const [selectedIgnoreIndex, setSelectedIgnoreIndex] = useState<number | null>(null);
    const [commonPaths, setCommonPaths] = useState<string[]>([]);
    const [showCommonPaths, setShowCommonPaths] = useState<boolean>(false);
    
    const [backupStatus, setBackupStatus] = useState<string>('Idle');
    const [logOutput, setLogOutput] = useState<string[]>([]);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [progress, setProgress] = useState<BackupProgress | null>(null);

    // Load initial data and set up event listeners
    useEffect(() => {
        // Load saved backups from localStorage
        const savedBackups = localStorage.getItem('savedBackups');
        if (savedBackups) {
            try {
                setBackups(JSON.parse(savedBackups));
            } catch (err) {
                console.error("Error loading saved backups:", err);
                addLog(`Error loading saved backups: ${err}`);
            }
        }

        // Set up event listeners for logging and status updates from Go
        EventsOn('app:log', (message: string) => {
            addLog(message);
        });

        EventsOn('app:backup:status', (status: string) => {
            setBackupStatus(status);
            if (status === 'Completed' || status === 'Failed' || status === 'Cancelled') {
                setIsProcessing(false);
                setProgress(null);
                
                // Update last backup time for the running backup
                if (status === 'Completed') {
                    // This would need to be enhanced to track which backup completed
                    const now = new Date().toLocaleString();
                    setBackups(prev => prev.map(backup => {
                        // Update all enabled backups (this is a simplified approach)
                        if (backup.enabled) {
                            return { ...backup, lastBackup: now };
                        }
                        return backup;
                    }));
                }
            }
        });

        EventsOn('app:backup:progress', (jsonProgress: string) => {
            try {
                const parsedProgress: BackupProgress = JSON.parse(jsonProgress);
                setProgress(parsedProgress);
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
    }, []);

    // Automatic backup scheduler
    useEffect(() => {
        const checkAndRunScheduledBackups = () => {
            const now = new Date();
            
            backups.forEach(backup => {
                if (!backup.enabled) return;
                
                let shouldRun = false;
                
                switch (backup.schedule) {
                    case 'hourly':
                        shouldRun = shouldRunHourly(now, backup.lastBackup || '');
                        break;
                    case 'daily':
                        shouldRun = shouldRunDaily(now, backup.lastBackup || '');
                        break;
                    case 'weekly':
                        shouldRun = shouldRunWeekly(now, backup.lastBackup || '');
                        break;
                    case 'monthly':
                        shouldRun = shouldRunMonthly(now, backup.lastBackup || '');
                        break;
                    case 'manual':
                    default:
                        shouldRun = false;
                        break;
                }
                
                if (shouldRun) {
                    addLog(`Running scheduled backup: ${backup.name}`);
                    handleRunBackup(backup);
                }
            });
        };

        const shouldRunHourly = (now: Date, lastBackup: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const hoursSinceLastBackup = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
            return hoursSinceLastBackup >= 1;
        };

        const shouldRunDaily = (now: Date, lastBackup: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const daysSinceLastBackup = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
            return daysSinceLastBackup >= 1;
        };

        const shouldRunWeekly = (now: Date, lastBackup: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const weeksSinceLastBackup = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24 * 7);
            return weeksSinceLastBackup >= 1;
        };

        const shouldRunMonthly = (now: Date, lastBackup: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const monthsSinceLastBackup = 
                (now.getFullYear() - last.getFullYear()) * 12 + 
                (now.getMonth() - last.getMonth());
            return monthsSinceLastBackup >= 1;
        };

        // Check every minute
        const interval = setInterval(checkAndRunScheduledBackups, 60000);
        
        // Run initial check
        checkAndRunScheduledBackups();
        
        return () => clearInterval(interval);
    }, [backups]); // Re-run when backups change

    const addLog = (message: string) => {
        const timestamp = new Date().toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
        setLogOutput(prev => [...prev, `[${timestamp}] ${message}`]);
    };

    // Save backups to localStorage
    const saveBackups = (updatedBackups: BackupConfig[]) => {
        localStorage.setItem('savedBackups', JSON.stringify(updatedBackups));
        setBackups(updatedBackups);
    };

    // Backup management functions
    const handleCreateBackup = () => {
        resetForm();
        setShowCreateForm(true);
    };

    const handleEditBackup = (backup: BackupConfig) => {
        setEditingBackup(backup);
        setFormBackupName(backup.name);
        setFormSourcePaths([...backup.sourcePaths]);
        setFormDestinationPath(backup.destinationPath);
        setFormIgnorePatterns([...backup.ignorePatterns]);
        setFormSchedule(backup.schedule);
        setShowEditForm(true);
    };

    const handleDeleteBackup = (backupId: string) => {
        if (confirm('Are you sure you want to delete this backup configuration?')) {
            const updatedBackups = backups.filter(b => b.id !== backupId);
            saveBackups(updatedBackups);
            addLog(`Deleted backup configuration`);
        }
    };

    const handleToggleBackup = (backupId: string) => {
        const updatedBackups = backups.map(backup => {
            if (backup.id === backupId) {
                const updated = { ...backup, enabled: !backup.enabled };
                addLog(`Backup '${backup.name}' ${updated.enabled ? 'enabled' : 'disabled'}`);
                return updated;
            }
            return backup;
        });
        saveBackups(updatedBackups);
    };

    const handleRunBackup = (backup: BackupConfig) => {
        if (backup.sourcePaths.length === 0) {
            addLog('Error: No source paths selected for this backup.');
            return;
        }
        if (!backup.destinationPath) {
            addLog('Error: Backup destination is not set.');
            return;
        }

        setIsProcessing(true);
        setBackupStatus(`Running backup: ${backup.name}`);
        addLog(`Starting backup: ${backup.name}`);
        setProgress(null);
        
        App.StartBackup(backup.destinationPath, backup.sourcePaths, backup.ignorePatterns).catch(err => {
            console.error("Error initiating backup:", err);
            addLog(`Error initiating backup: ${err}`);
            setIsProcessing(false);
            setBackupStatus('Failed');
        });
    };

    // Form handling functions
    const resetForm = () => {
        setFormBackupName('');
        setFormSourcePaths([]);
        setFormDestinationPath('');
        setFormIgnorePatterns([]);
        setFormSchedule('manual');
        setSelectedSourceIndex(null);
        setSelectedIgnoreIndex(null);
        setEditingBackup(null);
    };

    const handleSaveBackup = () => {
        if (!formBackupName.trim()) {
            alert('Please enter a backup name.');
            return;
        }
        if (formSourcePaths.length === 0) {
            alert('Please select at least one source directory.');
            return;
        }
        if (!formDestinationPath) {
            alert('Please select a destination directory.');
            return;
        }

        if (showEditForm && editingBackup) {
            // Update existing backup
            const updatedBackups = backups.map(backup => {
                if (backup.id === editingBackup.id) {
                    return {
                        ...backup,
                        name: formBackupName,
                        sourcePaths: formSourcePaths,
                        destinationPath: formDestinationPath,
                        ignorePatterns: formIgnorePatterns,
                        schedule: formSchedule
                    };
                }
                return backup;
            });
            saveBackups(updatedBackups);
            addLog(`Updated backup configuration: ${formBackupName}`);
        } else {
            // Create new backup
            const newBackup: BackupConfig = {
                id: Date.now().toString(),
                name: formBackupName,
                sourcePaths: formSourcePaths,
                destinationPath: formDestinationPath,
                ignorePatterns: formIgnorePatterns,
                schedule: formSchedule,
                enabled: true
            };
            saveBackups([...backups, newBackup]);
            addLog(`Created new backup configuration: ${formBackupName}`);
        }

        setShowCreateForm(false);
        setShowEditForm(false);
        resetForm();
    };

    const handleCancelForm = () => {
        setShowCreateForm(false);
        setShowEditForm(false);
        resetForm();
    };

    // Form-specific source/ignore handling
    const handleFormAddSourcePath = async () => {
        try {
            const selectedDir = await App.SelectSourceDirectory();
            if (selectedDir && !formSourcePaths.includes(selectedDir)) {
                setFormSourcePaths(prev => [...prev, selectedDir]);
            }
        } catch (err) {
            console.error("Error selecting source directory:", err);
        }
    };

    const handleLoadCommonPaths = async () => {
        try {
            const paths = await App.GetSuggestedBackupPaths();
            setCommonPaths(paths);
            setShowCommonPaths(true);
        } catch (err) {
            console.error("Error loading common paths:", err);
        }
    };

    const handleAddCommonPath = (path: string) => {
        if (!formSourcePaths.includes(path)) {
            setFormSourcePaths(prev => [...prev, path]);
        }
    };

    const handleFormRemoveSourcePath = () => {
        if (selectedSourceIndex !== null) {
            const newPaths = formSourcePaths.filter((_, index) => index !== selectedSourceIndex);
            setFormSourcePaths(newPaths);
            setSelectedSourceIndex(null);
        }
    };

    const handleFormAddIgnorePattern = () => {
        const pattern = prompt("Enter an ignore pattern (e.g., 'node_modules', '*.log'):");
        if (pattern && !formIgnorePatterns.includes(pattern)) {
            setFormIgnorePatterns(prev => [...prev, pattern]);
        }
    };

    const handleFormRemoveIgnorePattern = () => {
        if (selectedIgnoreIndex !== null) {
            const newPatterns = formIgnorePatterns.filter((_, index) => index !== selectedIgnoreIndex);
            setFormIgnorePatterns(newPatterns);
            setSelectedIgnoreIndex(null);
        }
    };

    const handleFormProposeIgnores = async () => {
        try {
            const proposed = await App.GetSuggestedIgnorePatterns();
            setFormIgnorePatterns(prev => [...new Set([...prev, ...proposed])]);
        } catch (err) {
            console.error("Error getting suggested ignore patterns:", err);
        }
    };

    const handleFormSelectDestination = async () => {
        try {
            const selectedDir = await App.SelectDestinationDirectory();
            if (selectedDir) {
                setFormDestinationPath(selectedDir);
            }
        } catch (err) {
            console.error("Error selecting destination directory:", err);
        }
    };

    return (
        <div id="app-container">
            <h1>Backup Manager</h1>

            {/* Main backup list view */}
            {!showCreateForm && !showEditForm && (
                <>
                    <section className="section-container">
                        <div className="section-header">
                            <h2>Backup Configurations</h2>
                            <button onClick={handleCreateBackup} className="primary-button">Create New Backup</button>
                        </div>
                        
                        {backups.length === 0 ? (
                            <div className="empty-state">
                                <p>No backup configurations yet.</p>
                                <p>Click "Create New Backup" to get started.</p>
                            </div>
                        ) : (
                            <div className="backup-list">
                                {backups.map(backup => (
                                    <div key={backup.id} className={`backup-item ${backup.enabled ? 'enabled' : 'disabled'}`}>
                                        <div className="backup-header">
                                            <h3>{backup.name}</h3>
                                            <div className="backup-status">
                                                <span className={`status-indicator ${backup.enabled ? 'enabled' : 'disabled'}`}>
                                                    {backup.enabled ? 'Enabled' : 'Disabled'}
                                                </span>
                                                <span className="schedule-info">{backup.schedule}</span>
                                            </div>
                                        </div>
                                        
                                        <div className="backup-details">
                                            <div className="detail-row">
                                                <strong>Source:</strong>
                                                <span>{backup.sourcePaths.length > 0 ? `${backup.sourcePaths.length} directories` : 'None'}</span>
                                            </div>
                                            <div className="detail-row">
                                                <strong>Destination:</strong>
                                                <span>{backup.destinationPath || 'Not set'}</span>
                                            </div>
                                            {backup.lastBackup && (
                                                <div className="detail-row">
                                                    <strong>Last Backup:</strong>
                                                    <span>{backup.lastBackup}</span>
                                                </div>
                                            )}
                                        </div>

                                        <div className="backup-actions">
                                            <button
                                                onClick={() => handleRunBackup(backup)}
                                                disabled={!backup.enabled || isProcessing}
                                                className="run-button"
                                            >
                                                Run Now
                                            </button>
                                            <button
                                                onClick={() => handleToggleBackup(backup.id)}
                                                className={backup.enabled ? 'disable-button' : 'enable-button'}
                                            >
                                                {backup.enabled ? 'Disable' : 'Enable'}
                                            </button>
                                            <button
                                                onClick={() => handleEditBackup(backup)}
                                                className="edit-button"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => handleDeleteBackup(backup.id)}
                                                className="delete-button"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* Status and Log Section */}
                    <section className="section-container">
                        <h2>Status & Logs</h2>
                        <div className="status-display">
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
                        </div>
                        
                        <div className="log-output">
                            <h3>Activity Log</h3>
                            <div className="log-container">
                                {logOutput.length === 0 ? (
                                    <p className="empty-log">No activity yet.</p>
                                ) : (
                                    logOutput.slice(-50).map((line, index) => (
                                        <div key={index} className="log-line">{line}</div>
                                    ))
                                )}
                            </div>
                        </div>
                    </section>
                </>
            )}

            {/* Create/Edit Backup Form */}
            {(showCreateForm || showEditForm) && (
                <section className="section-container">
                    <h2>{showEditForm ? 'Edit Backup Configuration' : 'Create New Backup Configuration'}</h2>
                    
                    <div className="form-section">
                        <div className="form-group">
                            <label htmlFor="backup-name">Backup Name:</label>
                            <input
                                id="backup-name"
                                type="text"
                                value={formBackupName}
                                onChange={(e) => setFormBackupName(e.target.value)}
                                placeholder="e.g., Documents Backup"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="schedule">Schedule:</label>
                            <select
                                id="schedule"
                                value={formSchedule}
                                onChange={(e) => setFormSchedule(e.target.value)}
                            >
                                <option value="manual">Manual Only</option>
                                <option value="hourly">Hourly</option>
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                                <option value="monthly">Monthly</option>
                            </select>
                        </div>

                        <div className="form-section">
                            <h3>Source Directories</h3>
                            <div className="list-container">
                                {formSourcePaths.length === 0 ? (
                                    <p>No source directories added yet.</p>
                                ) : (
                                    <ul>
                                        {formSourcePaths.map((path, index) => (
                                            <li
                                                key={path}
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
                                <button onClick={handleFormAddSourcePath}>Add Source</button>
                                <button onClick={handleLoadCommonPaths}>Common Paths</button>
                                <button onClick={handleFormRemoveSourcePath} disabled={selectedSourceIndex === null}>Remove Selected</button>
                            </div>
                        </div>

                        <div className="form-section">
                            <h3>Ignore Patterns</h3>
                            <div className="list-container">
                                {formIgnorePatterns.length === 0 ? (
                                    <p>No ignore patterns defined.</p>
                                ) : (
                                    <ul>
                                        {formIgnorePatterns.map((pattern, index) => (
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
                                <button onClick={handleFormAddIgnorePattern}>Add Pattern</button>
                                <button onClick={handleFormRemoveIgnorePattern} disabled={selectedIgnoreIndex === null}>Remove Selected</button>
                                <button onClick={handleFormProposeIgnores}>Propose Defaults</button>
                            </div>
                        </div>

                        <div className="form-section">
                            <h3>Backup Destination</h3>
                            <div className="input-group">
                                <input
                                    type="text"
                                    value={formDestinationPath || 'No destination selected'}
                                    readOnly
                                    className="destination-input"
                                />
                                <button onClick={handleFormSelectDestination}>Select Destination</button>
                            </div>
                        </div>

                        <div className="form-actions">
                            <button onClick={handleSaveBackup} className="save-button">
                                {showEditForm ? 'Update Backup' : 'Create Backup'}
                            </button>
                            <button onClick={handleCancelForm} className="cancel-button">Cancel</button>
                        </div>
                    </div>
                </section>
            )}

            {/* Common Paths Modal */}
            {showCommonPaths && (
                <div className="modal-overlay" onClick={() => setShowCommonPaths(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>Common Backup Paths</h3>
                            <button className="modal-close" onClick={() => setShowCommonPaths(false)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            {commonPaths.length === 0 ? (
                                <p>No common paths found.</p>
                            ) : (
                                <ul className="common-paths-list">
                                    {commonPaths.map((path, index) => (
                                        <li key={index} className="common-path-item">
                                            <span className="path-text">{path}</span>
                                            <button 
                                                className="add-path-button"
                                                onClick={() => handleAddCommonPath(path)}
                                                disabled={formSourcePaths.includes(path)}
                                            >
                                                {formSourcePaths.includes(path) ? 'Added' : 'Add'}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="cancel-button" onClick={() => setShowCommonPaths(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default BackupApp;
