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
    const [canPause, setCanPause] = useState<boolean>(false);
    const [canStop, setCanStop] = useState<boolean>(false);
    const [canResume, setCanResume] = useState<boolean>(false);

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
            
            // Update control states based on backup status
            if (status === 'Running') {
                setIsProcessing(true);
                setCanPause(true);
                setCanStop(true);
                setCanResume(false);
            } else if (status === 'Paused') {
                setIsProcessing(false);
                setCanPause(false);
                setCanStop(true);
                setCanResume(true);
            } else if (status === 'Stopped') {
                setIsProcessing(false);
                setCanPause(false);
                setCanStop(false);
                setCanResume(true);
            } else if (status === 'Completed' || status === 'Failed' || status === 'Cancelled') {
                setIsProcessing(false);
                setProgress(null);
                setCanPause(false);
                setCanStop(false);
                setCanResume(false);
                
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

        // Listen for resumable backup notifications
        EventsOn('app:backup:resumable', (message: string) => {
            addLog(message);
            if (confirm('Found an interrupted backup. Would you like to resume it?')) {
                handleResumeBackup();
            }
        });

        // Cleanup event listeners on component unmount
        return () => {
            EventsOff('app:log');
            EventsOff('app:backup:status');
            EventsOff('app:backup:progress');
            EventsOff('app:backup:resumable');
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

        const shouldRunHourly = (now: Date, lastBackup?: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const hoursSinceLastBackup = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
            return hoursSinceLastBackup >= 1;
        };

        const shouldRunDaily = (now: Date, lastBackup?: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const daysSinceLastBackup = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
            return daysSinceLastBackup >= 1;
        };

        const shouldRunWeekly = (now: Date, lastBackup?: string): boolean => {
            if (!lastBackup) return true;
            
            const last = new Date(lastBackup);
            const weeksSinceLastBackup = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24 * 7);
            return weeksSinceLastBackup >= 1;
        };

        const shouldRunMonthly = (now: Date, lastBackup?: string): boolean => {
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
        setCanPause(true);
        setCanStop(true);
        setCanResume(false);
        setBackupStatus(`Running backup: ${backup.name}`);
        addLog(`Starting backup: ${backup.name}`);
        setProgress(null);
        
        App.StartBackup(backup.destinationPath, backup.sourcePaths, backup.ignorePatterns).catch(err => {
            console.error("Error initiating backup:", err);
            addLog(`Error initiating backup: ${err}`);
            setIsProcessing(false);
            setCanPause(false);
            setCanStop(false);
            setCanResume(false);
            setBackupStatus('Failed');
        });
    };

    // Backup control functions
    const handlePauseBackup = async () => {
        try {
            await App.PauseBackup();
            addLog('Backup paused');
        } catch (err: any) {
            addLog(`Error pausing backup: ${err}`);
            console.error("Error pausing backup:", err);
        }
    };

    const handleStopBackup = async () => {
        try {
            await App.StopBackup();
            addLog('Backup stopped');
        } catch (err: any) {
            addLog(`Error stopping backup: ${err}`);
            console.error("Error stopping backup:", err);
        }
    };

    const handleResumeBackup = async () => {
        try {
            await App.ResumeBackup();
            addLog('Resuming backup...');
        } catch (err: any) {
            addLog(`Error resuming backup: ${err}`);
            console.error("Error resuming backup:", err);
        }
    };

    const handleRestartBackup = async (backup: BackupConfig) => {
        if (backup.sourcePaths.length === 0) {
            addLog('Error: No source paths selected for this backup.');
            return;
        }
        if (!backup.destinationPath) {
            addLog('Error: Backup destination is not set.');
            return;
        }

        try {
            const config = {
                id: Date.now().toString(),
                name: backup.name,
                sourcePaths: backup.sourcePaths,
                destinationPath: backup.destinationPath,
                ignorePatterns: backup.ignorePatterns
            };
            
            await App.RestartBackup(config);
            addLog(`Restarting backup: ${backup.name}`);
        } catch (err: any) {
            addLog(`Error restarting backup: ${err}`);
            console.error("Error restarting backup:", err);
        }
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
        <div className="flex flex-col max-w-2xl mx-5 my-5 p-5 bg-white rounded-lg shadow-lg md:mx-auto md:my-5 md:p-5 lg:max-w-2xl xl:max-w-2xl">
            <h1 className="text-3xl font-bold text-center text-slate-700 mb-8">Backup Manager</h1>

            {/* Main backup list view */}
            {!showCreateForm && !showEditForm && (
                <>
                    <section className="mb-6 p-4 border border-gray-300 rounded-md bg-gray-50">
                        <div className="flex justify-between items-center mb-5">
                            <h2 className="text-xl font-semibold text-slate-600 mt-0 border-b border-gray-200 pb-2.5 mb-4">Backup Configurations</h2>
                            <button onClick={handleCreateBackup} className="bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Create New Backup</button>
                        </div>
                        
                        {backups.length === 0 ? (
                            <div className="text-center py-10 px-5 text-gray-600 bg-gray-100 rounded-md border-2 border-dashed border-gray-300">
                                <p className="mb-2">No backup configurations yet.</p>
                                <p>Click "Create New Backup" to get started.</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-4">
                                {backups.map(backup => (
                                    <div key={backup.id} className={`border border-gray-300 rounded-lg p-5 bg-white transition-all duration-200 hover:shadow-md hover:border-blue-500 ${backup.enabled ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-red-500 opacity-70'}`}>
                                        <div className="flex justify-between items-center mb-4">
                                            <h3 className="m-0 text-slate-700 text-lg font-semibold">{backup.name}</h3>
                                            <div className="flex gap-2.5 items-center">
                                                <span className={`px-2 py-1 rounded-full text-xs font-bold uppercase ${backup.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                                    {backup.enabled ? 'Enabled' : 'Disabled'}
                                                </span>
                                                <span className="bg-blue-100 text-blue-900 px-2 py-1 rounded-full text-xs font-bold">{backup.schedule}</span>
                                            </div>
                                        </div>
                                        
                                        <div className="mb-4">
                                            <div className="flex mb-1.5 gap-2.5">
                                                <strong className="min-w-[100px] text-gray-600">Source:</strong>
                                                <span>{backup.sourcePaths.length > 0 ? `${backup.sourcePaths.length} directories` : 'None'}</span>
                                            </div>
                                            <div className="flex mb-1.5 gap-2.5">
                                                <strong className="min-w-[100px] text-gray-600">Destination:</strong>
                                                <span>{backup.destinationPath || 'Not set'}</span>
                                            </div>
                                            {backup.lastBackup && (
                                                <div className="flex mb-1.5 gap-2.5">
                                                    <strong className="min-w-[100px] text-gray-600">Last Backup:</strong>
                                                    <span>{backup.lastBackup}</span>
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex gap-2 flex-wrap">
                                            <button
                                                onClick={() => handleRunBackup(backup)}
                                                disabled={!backup.enabled || isProcessing}
                                                className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
                                            >
                                                Run Now
                                            </button>
                                            <button
                                                onClick={() => handleRestartBackup(backup)}
                                                disabled={!backup.enabled || isProcessing}
                                                className="bg-orange-600 hover:bg-orange-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
                                            >
                                                🔄 Restart
                                            </button>
                                            <button
                                                onClick={() => handleToggleBackup(backup.id)}
                                                className={backup.enabled ? 'bg-yellow-500 hover:bg-yellow-600 text-gray-900 font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed' : 'bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed'}
                                            >
                                                {backup.enabled ? 'Disable' : 'Enable'}
                                            </button>
                                            <button
                                                onClick={() => handleEditBackup(backup)}
                                                className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => handleDeleteBackup(backup.id)}
                                                className="bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
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
                    <section className="mb-6 p-4 border border-gray-300 rounded-md bg-gray-50">
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-xl font-semibold text-slate-600 mt-0 border-b border-gray-200 pb-2.5">Status & Logs</h2>
                            
                            {/* Backup Control Buttons */}
                            {(canPause || canStop || canResume) && (
                                <div className="flex gap-2">
                                    {canPause && (
                                        <button
                                            onClick={handlePauseBackup}
                                            className="bg-yellow-500 hover:bg-yellow-600 text-gray-900 font-medium py-2 px-4 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
                                        >
                                            ⏸ Pause
                                        </button>
                                    )}
                                    {canStop && (
                                        <button
                                            onClick={handleStopBackup}
                                            className="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
                                        >
                                            ⏹ Stop
                                        </button>
                                    )}
                                    {canResume && (
                                        <button
                                            onClick={handleResumeBackup}
                                            className="bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed"
                                        >
                                            ▶ Resume
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                        
                        <div className="bg-gray-100 p-4 rounded-md border-l-4 border-l-blue-500 mb-5">
                            <p className="text-gray-700">
                                Current Status: <strong className="font-semibold">{backupStatus}</strong>
                                {progress && (
                                    <>
                                        <br className="leading-relaxed" />Files: {progress.filesProcessed}/{progress.totalFiles}
                                        {progress.currentFile && <br className="leading-relaxed" />}
                                        {progress.currentFile && `Processing: ${progress.currentFile}`}
                                        {progress.status && <br className="leading-relaxed" />}
                                        {progress.status && `Detail: ${progress.status}`}
                                        {progress.error && <br className="leading-relaxed" />}
                                        {progress.error && `Error: ${progress.error}`}
                                    </>
                                )}
                            </p>
                        </div>
                        
                        <div className="mt-5 bg-gray-800 text-green-400 font-mono p-4 rounded-md max-h-[250px] overflow-y-auto text-sm leading-tight whitespace-pre-wrap">
                            <h3 className="text-green-500 mt-0 mb-2.5 border-b border-green-900 pb-1.5">Activity Log</h3>
                            <div className="max-h-[300px] overflow-y-auto overflow-x-hidden bg-gray-800 text-green-400 font-mono p-4 rounded-md text-sm leading-tight text-left whitespace-pre-wrap break-all">
                                {logOutput.length === 0 ? (
                                    <p className="text-gray-500 italic text-center py-5">No activity yet.</p>
                                ) : (
                                    logOutput.slice(-50).map((line, index) => (
                                        <div key={index} className="mb-0.5 break-words text-left">{line}</div>
                                    ))
                                )}
                            </div>
                        </div>
                    </section>
                </>
            )}

            {/* Create/Edit Backup Form */}
            {(showCreateForm || showEditForm) && (
                <section className="mb-6 p-4 border border-gray-300 rounded-md bg-gray-50">
                    <h2 className="text-xl font-semibold text-slate-600 mt-0 border-b border-gray-200 pb-2.5 mb-4">{showEditForm ? 'Edit Backup Configuration' : 'Create New Backup Configuration'}</h2>
                    
                    <div className="mb-6 p-5 bg-gray-100 rounded-md border border-gray-200">
                        <div className="mb-5">
                            <label htmlFor="backup-name" className="block mb-1.5 font-bold text-gray-700">Backup Name:</label>
                            <input
                                id="backup-name"
                                type="text"
                                value={formBackupName}
                                onChange={(e) => setFormBackupName(e.target.value)}
                                placeholder="e.g., Documents Backup"
                                className="w-full p-2.5 border border-gray-300 rounded-md text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            />
                        </div>

                        <div className="mb-5">
                            <label htmlFor="schedule" className="block mb-1.5 font-bold text-gray-700">Schedule:</label>
                            <select
                                id="schedule"
                                value={formSchedule}
                                onChange={(e) => setFormSchedule(e.target.value)}
                                className="w-full p-2.5 border border-gray-300 rounded-md text-base bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            >
                                <option value="manual">Manual Only</option>
                                <option value="hourly">Hourly</option>
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                                <option value="monthly">Monthly</option>
                            </select>
                        </div>

                        <div className="mb-6 p-5 bg-gray-100 rounded-md border border-gray-200">
                            <h3 className="mt-0 mb-4 text-gray-700 border-b border-gray-300 pb-2">Source Directories</h3>
                            <div className="min-h-[50px] max-h-[200px] overflow-y-auto border border-gray-300 rounded-md p-2.5 bg-gray-50">
                                {formSourcePaths.length === 0 ? (
                                    <p className="text-gray-600">No source directories added yet.</p>
                                ) : (
                                    <ul className="list-none p-0 m-0">
                                        {formSourcePaths.map((path, index) => (
                                            <li
                                                key={path}
                                                className={`p-2 mb-1.5 bg-white border rounded-md cursor-pointer transition-colors duration-200 break-words ${selectedSourceIndex === index ? 'bg-blue-50 border-blue-500 font-bold' : 'border-gray-200 hover:bg-gray-100'}`}
                                                onClick={() => setSelectedSourceIndex(index)}
                                            >
                                                {path}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            <div className="flex gap-2.5 mt-4">
                                <button onClick={handleFormAddSourcePath} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Add Source</button>
                                <button onClick={handleLoadCommonPaths} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Common Paths</button>
                                <button onClick={handleFormRemoveSourcePath} disabled={selectedSourceIndex === null} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Remove Selected</button>
                            </div>
                        </div>

                        <div className="mb-6 p-5 bg-gray-100 rounded-md border border-gray-200">
                            <h3 className="mt-0 mb-4 text-gray-700 border-b border-gray-300 pb-2">Ignore Patterns</h3>
                            <div className="min-h-[50px] max-h-[200px] overflow-y-auto border border-gray-300 rounded-md p-2.5 bg-gray-50">
                                {formIgnorePatterns.length === 0 ? (
                                    <p className="text-gray-600">No ignore patterns defined.</p>
                                ) : (
                                    <ul className="list-none p-0 m-0">
                                        {formIgnorePatterns.map((pattern, index) => (
                                            <li
                                                key={pattern}
                                                className={`p-2 mb-1.5 bg-white border rounded-md cursor-pointer transition-colors duration-200 break-words ${selectedIgnoreIndex === index ? 'bg-blue-50 border-blue-500 font-bold' : 'border-gray-200 hover:bg-gray-100'}`}
                                                onClick={() => setSelectedIgnoreIndex(index)}
                                            >
                                                {pattern}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            <div className="flex gap-2.5 mt-4">
                                <button onClick={handleFormAddIgnorePattern} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Add Pattern</button>
                                <button onClick={handleFormRemoveIgnorePattern} disabled={selectedIgnoreIndex === null} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Remove Selected</button>
                                <button onClick={handleFormProposeIgnores} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Propose Defaults</button>
                            </div>
                        </div>

                        <div className="mb-6 p-5 bg-gray-100 rounded-md border border-gray-200">
                            <h3 className="mt-0 mb-4 text-gray-700 border-b border-gray-300 pb-2">Backup Destination</h3>
                            <div className="flex gap-2.5 mt-4 items-center">
                                <input
                                    type="text"
                                    value={formDestinationPath || 'No destination selected'}
                                    readOnly
                                    className="flex-grow p-2.5 border border-gray-300 rounded-md text-base bg-gray-50 cursor-default"
                                />
                                <button onClick={handleFormSelectDestination} className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Select Destination</button>
                            </div>
                        </div>

                        <div className="flex gap-2.5 justify-end pt-5 border-t border-gray-300">
                            <button onClick={handleSaveBackup} className="bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">
                                {showEditForm ? 'Update Backup' : 'Create Backup'}
                            </button>
                            <button onClick={handleCancelForm} className="bg-gray-600 hover:bg-gray-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">Cancel</button>
                        </div>
                    </div>
                </section>
            )}

            {/* Common Paths Modal */}
            {showCommonPaths && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50" onClick={() => setShowCommonPaths(false)}>
                    <div className="bg-white rounded-lg shadow-xl max-w-md w-[90%] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center p-4 p-5 border-b border-gray-300">
                            <h3 className="m-0 text-slate-700 text-lg font-semibold">Common Backup Paths</h3>
                            <button className="bg-transparent border-none text-2xl cursor-pointer text-gray-600 p-0 w-[30px] h-[30px] flex items-center justify-center hover:text-gray-800" onClick={() => setShowCommonPaths(false)}>&times;</button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1">
                            {commonPaths.length === 0 ? (
                                <p className="text-gray-600">No common paths found.</p>
                            ) : (
                                <ul className="list-none p-0 m-0">
                                    {commonPaths.map((path, index) => (
                                        <li key={index} className="flex justify-between items-center py-2.5 border-b border-gray-200 last:border-b-0">
                                            <span className="flex-1 font-mono text-sm text-gray-700 mr-4 break-all">{path}</span>
                                            <button 
                                                className="bg-green-600 text-white border-none py-1.5 px-3 rounded-md cursor-pointer text-sm min-w-[60px] hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors duration-200"
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
                        <div className="p-4 p-5 border-t border-gray-300 flex justify-end">
                            <button className="bg-gray-600 hover:bg-gray-700 text-white font-medium py-2.5 px-4.5 rounded-md transition-colors duration-200 disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed" onClick={() => setShowCommonPaths(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default BackupApp;
