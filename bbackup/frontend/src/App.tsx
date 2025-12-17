import React, { useState, useEffect } from 'react';

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
    const [newIgnorePattern, setNewIgnorePattern] = useState<string>('');
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
                const parsedBackups = JSON.parse(savedBackups);
                setBackups(parsedBackups);
                
                // Send saved backup configurations to backend for state restoration
                App.SetSavedBackups(parsedBackups).catch(err => {
                    console.error("Error setting saved backups in backend:", err);
                    addLog(`Error setting saved backups in backend: ${err}`);
                });
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
            // Use setTimeout to prevent blocking the event handler
            setTimeout(() => {
                if (confirm('Found an interrupted backup. Would you like to resume it?')) {
                    handleResumeBackup();
                }
            }, 0);
        });

        // Check for existing backup state on app startup
        const checkExistingBackupState = async () => {
            try {
                const backupStates = await App.CheckAllBackupStates();
                const activeBackups = Object.entries(backupStates).filter(([_, state]) => 
                    state.status === 'running' || state.status === 'paused'
                );
                
                if (activeBackups.length > 0) {
                    const [destination, state] = activeBackups[0]; // Get first active backup
                    addLog(`Found active backup in ${destination}: ${state.status}`);
                    
                    // Set the UI state to match the backup state
                    setBackupStatus(state.status.charAt(0).toUpperCase() + state.status.slice(1));
                    
                    if (state.status === 'running') {
                        setIsProcessing(true);
                        setCanPause(true);
                        setCanStop(true);
                        setCanResume(false);
                    } else if (state.status === 'paused') {
                        setIsProcessing(false);
                        setCanPause(false);
                        setCanStop(true);
                        setCanResume(true);
                    }
                    
                    // Set progress if available
                    if (state.progress && state.progress.filesProcessed > 0) {
                        setProgress(state.progress);
                    }
                    
                    // Ask user if they want to resume
                    if (confirm(`Found ${state.status} backup in ${destination}. Would you like to resume?`)) {
                        handleResumeBackup();
                    }
                }
            } catch (err) {
                console.error("Error checking backup state:", err);
            }
        };
        
        // Check after a short delay to ensure event listeners are set up
        setTimeout(checkExistingBackupState, 500);

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
        setNewIgnorePattern('');
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
        if (backupStatus !== 'Running') {
            addLog('Cannot pause: No backup is currently running');
            return;
        }
        try {
            await App.PauseBackup();
            addLog('Backup paused');
        } catch (err: any) {
            addLog(`Error pausing backup: ${err}`);
            console.error("Error pausing backup:", err);
            // Fallback: reset UI state since there's no actual backup running
            setBackupStatus('Idle');
            setIsProcessing(false);
            setCanPause(false);
            setCanStop(false);
            setCanResume(false);
            addLog('Reset backup status - no active backup process found');
        }
    };

    const handleStopBackup = async () => {
        if (backupStatus !== 'Running' && backupStatus !== 'Paused') {
            addLog('Cannot stop: No backup is currently running or paused');
            return;
        }
        try {
            await App.StopBackup();
            addLog('Backup stopped');
        } catch (err: any) {
            addLog(`Error stopping backup: ${err}`);
            console.error("Error stopping backup:", err);
            // Fallback: reset UI state since there's no actual backup running
            setBackupStatus('Idle');
            setIsProcessing(false);
            setCanPause(false);
            setCanStop(false);
            setCanResume(false);
            addLog('Reset backup status - no active backup process found');
        }
    };

    const handleResumeBackup = async () => {
        if (backupStatus !== 'Paused') {
            addLog('Cannot resume: No backup is currently paused');
            return;
        }
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
        setNewIgnorePattern('');
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
        if (newIgnorePattern.trim() && !formIgnorePatterns.includes(newIgnorePattern.trim())) {
            setFormIgnorePatterns(prev => [...prev, newIgnorePattern.trim()]);
            setNewIgnorePattern('');
        }
    };

    const handleIgnorePatternKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleFormAddIgnorePattern();
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

    const enabledCount = backups.filter(b => b.enabled).length;
    const scheduledCount = backups.filter(b => b.enabled && b.schedule !== 'manual').length;
    const totalSources = backups.reduce((sum, b) => sum + b.sourcePaths.length, 0);
    const lastActivity = logOutput[logOutput.length - 1] || 'Waiting for first run';

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50 relative overflow-hidden">
            <div className="pointer-events-none absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(59,130,246,0.25),transparent_35%),radial-gradient(circle_at_80%_0%,rgba(16,185,129,0.2),transparent_30%),radial-gradient(circle_at_50%_80%,rgba(236,72,153,0.2),transparent_30%)]" />
            <div className="relative w-full">
                <div className="glass w-full px-4 py-6 rounded-t-2xl shadow-2xl fade-in border border-white/10">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between mb-8">
                        <div>
                            <h1 className="text-4xl font-bold text-white mb-2 flex items-center gap-3">
                                <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-indigo-500 shadow-lg">
                                    <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                                    </svg>
                                </span>
                                Backup Manager
                            </h1>
                            <p className="text-white/80 text-lg">Secure and automated backup solution for your files</p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <button 
                                onClick={handleCreateBackup} 
                                className="btn bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white font-semibold py-3 px-6 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105 flex items-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                </svg>
                                Create New Backup
                            </button>
                            <span className="hidden lg:inline-flex items-center gap-2 px-4 py-3 rounded-xl bg-white/10 text-white border border-white/10">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                Status: {backupStatus}
                            </span>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                        <div className="bg-white/10 border border-white/10 rounded-xl p-4 shadow-sm">
                            <p className="text-sm text-white/70">Backups</p>
                            <p className="text-3xl font-bold text-white">{backups.length}</p>
                            <p className="text-xs text-white/60">Enabled: {enabledCount}</p>
                        </div>
                        <div className="bg-white/10 border border-white/10 rounded-xl p-4 shadow-sm">
                            <p className="text-sm text-white/70">Scheduled</p>
                            <p className="text-3xl font-bold text-white">{scheduledCount}</p>
                            <p className="text-xs text-white/60">Non-manual</p>
                        </div>
                        <div className="bg-white/10 border border-white/10 rounded-xl p-4 shadow-sm">
                            <p className="text-sm text-white/70">Watched paths</p>
                            <p className="text-3xl font-bold text-white">{totalSources}</p>
                            <p className="text-xs text-white/60">Across all backups</p>
                        </div>
                        <div className="bg-white/10 border border-white/10 rounded-xl p-4 shadow-sm">
                            <p className="text-sm text-white/70">Last activity</p>
                            <p className="text-base font-semibold text-white">{lastActivity}</p>
                        </div>
                    </div>

            {/* Main backup list view */}
            {!showCreateForm && !showEditForm && (
                <div className="grid gap-6 grid-cols-1">
                    <section className="px-4 py-6 bg-white/90 backdrop-blur rounded-xl border border-white/20 shadow-lg card fade-in">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-semibold text-gray-800 flex items-center gap-2">
                                <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                </svg>
                                Backup Configurations
                            </h2>
                        </div>
                        
                        {backups.length === 0 ? (
                            <div className="text-center py-16 px-8 text-gray-600 bg-gradient-to-br from-gray-50 to-gray-100 rounded-2xl border-2 border-dashed border-gray-300">
                                <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                                </svg>
                                <p className="text-xl font-medium mb-2">No backup configurations yet</p>
                                <p className="text-gray-500">Click "Create New Backup" to get started with your first backup configuration</p>
                            </div>
                        ) : (
                            <div className="grid gap-6">
                                {backups.map(backup => (
                                    <div key={backup.id} className={`bg-white rounded-xl p-6 border-2 shadow-md card transition-all duration-300 ${
                                        backup.enabled 
                                            ? 'border-l-4 border-l-emerald-500 hover:border-emerald-400 hover:shadow-lg' 
                                            : 'border-l-4 border-l-gray-400 opacity-75 hover:border-gray-400'
                                    }`}>
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="flex-1">
                                                <h3 className="text-xl font-semibold text-gray-800 mb-2 flex items-center gap-2">
                                                    {backup.enabled ? (
                                                        <svg className="w-5 h-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                                        </svg>
                                                    ) : (
                                                        <svg className="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                                                        </svg>
                                                    )}
                                                    {backup.name}
                                                </h3>
                                            </div>
                                            <div className="flex gap-2 items-center">
                                                <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                                                    backup.enabled 
                                                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                                                        : 'bg-gray-100 text-gray-600 border border-gray-200'
                                                }`}>
                                                    {backup.enabled ? 'Enabled' : 'Disabled'}
                                                </span>
                                                <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-semibold border border-blue-200">
                                                    {backup.schedule}
                                                </span>
                                            </div>
                                        </div>
                                        
                                        <div className="space-y-3 mb-6">
                                            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                                                <svg className="w-5 h-5 text-primary-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                                </svg>
                                                <div>
                                                    <p className="text-sm font-medium text-gray-700">Source</p>
                                                    <p className="text-gray-900">{backup.sourcePaths.length > 0 ? `${backup.sourcePaths.length} directories` : 'None selected'}</p>
                                                </div>
                                            </div>
                                            
                                            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                                                <svg className="w-5 h-5 text-primary-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                                </svg>
                                                <div>
                                                    <p className="text-sm font-medium text-gray-700">Destination</p>
                                                    <p className="text-gray-900 truncate">{backup.destinationPath || 'Not set'}</p>
                                                </div>
                                            </div>
                                            
                                            {backup.lastBackup && (
                                                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                                                    <svg className="w-5 h-5 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                    </svg>
                                                    <div>
                                                        <p className="text-sm font-medium text-gray-700">Last Backup</p>
                                                        <p className="text-gray-900">{backup.lastBackup}</p>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex gap-3 flex-wrap">
                                            <button
                                                onClick={() => handleRunBackup(backup)}
                                                disabled={!backup.enabled || (backupStatus === 'Running' || backupStatus === 'Paused')}
                                                className="btn bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                                Run Now
                                            </button>
                                            <button
                                                onClick={() => handleRestartBackup(backup)}
                                                disabled={!backup.enabled || isProcessing}
                                                className="btn bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                                </svg>
                                                Restart
                                            </button>
                                            <button
                                                onClick={() => handleToggleBackup(backup.id)}
                                                className={`btn font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2 ${
                                                    backup.enabled 
                                                        ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white'
                                                        : 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white'
                                                }`}
                                            >
                                                {backup.enabled ? (
                                                    <>
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                        </svg>
                                                        Disable
                                                    </>
                                                ) : (
                                                    <>
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                        </svg>
                                                        Enable
                                                    </>
                                                )}
                                            </button>
                                            <button
                                                onClick={() => handleEditBackup(backup)}
                                                className="btn bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                                </svg>
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => handleDeleteBackup(backup.id)}
                                                className="btn bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                </svg>
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* Status and Log Section */}
                    <section className="px-4 py-6 bg-white/90 backdrop-blur rounded-xl border border-white/20 shadow-lg card fade-in">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-semibold text-gray-800 flex items-center gap-2">
                                <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                Status & Logs
                            </h2>
                            
                            {/* Backup Control Buttons */}
                            {(backupStatus === 'Running' || backupStatus === 'Paused' || backupStatus === 'Stopped') && (
                                <div className="flex gap-3">
                                    {canPause && (
                                        <button
                                            onClick={handlePauseBackup}
                                            className="btn bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            Pause
                                        </button>
                                    )}
                                    {canStop && (
                                        <button
                                            onClick={handleStopBackup}
                                            className="btn bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h6v4H9z" />
                                            </svg>
                                            Stop
                                        </button>
                                    )}
                                    {canResume && (
                                        <button
                                            onClick={handleResumeBackup}
                                            className="btn bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            Resume
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                        
                        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-6 rounded-xl border-l-4 border-l-blue-500 mb-6 shadow-inner">
                            <div className="flex items-center gap-3 mb-3">
                                <div className={`w-3 h-3 rounded-full ${
                                    backupStatus === 'Running' ? 'bg-emerald-500 animate-pulse' : 
                                    backupStatus === 'Paused' ? 'bg-amber-500' : 
                                    backupStatus === 'Completed' ? 'bg-blue-500' : 
                                    backupStatus === 'Failed' || backupStatus === 'Stopped' ? 'bg-red-500' : 'bg-gray-500'
                                }`}></div>
                                <h3 className="text-lg font-semibold text-gray-800">Current Status</h3>
                            </div>
                            <p className="text-gray-900 text-lg">
                                <span className={`font-bold capitalize ${
                                    backupStatus === 'Running' ? 'text-emerald-600' : 
                                    backupStatus === 'Paused' ? 'text-amber-600' : 
                                    backupStatus === 'Completed' ? 'text-blue-600' : 
                                    backupStatus === 'Failed' || backupStatus === 'Stopped' ? 'text-red-600' : 'text-gray-600'
                                }`}>{backupStatus}</span>
                                {progress && (
                                    <>
                                        <div className="mt-3 space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-gray-700 font-medium">Progress:</span>
                                                <span className="text-gray-900 font-semibold">
                                                    {progress.filesProcessed} / {progress.totalFiles} files
                                                </span>
                                            </div>
                                            
                                            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                                <div 
                                                    className="bg-gradient-to-r from-blue-500 to-indigo-600 h-2 rounded-full transition-all duration-500 ease-out"
                                                    style={{ width: `${progress.totalFiles > 0 ? (progress.filesProcessed / progress.totalFiles) * 100 : 0}%` }}
                                                ></div>
                                            </div>
                                            
                                            {progress.currentFile && (
                                                <div className="flex items-center gap-2 text-gray-700">
                                                    <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                                    </svg>
                                                    <span className="text-sm truncate">Processing: {progress.currentFile}</span>
                                                </div>
                                            )}
                                            
                                            {progress.status && (
                                                <div className="text-sm text-gray-600 bg-gray-100/80 p-2 rounded-lg">
                                                    <span className="font-medium">Details:</span> {progress.status}
                                                </div>
                                            )}
                                            
                                            {progress.error && (
                                                <div className="text-sm text-red-700 bg-red-50 p-3 rounded-lg border-l-4 border-l-red-500">
                                                    <span className="font-medium">Error:</span> {progress.error}
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </p>
                        </div>
                        
                        <div className="bg-gray-900 text-emerald-400 font-mono rounded-xl shadow-inner">
                            <div className="p-4 border-b border-gray-700">
                                <h3 className="text-emerald-400 font-semibold flex items-center gap-2">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                    Activity Log
                                </h3>
                            </div>
                            <div className="max-h-80 overflow-y-auto overflow-x-hidden p-4 text-sm leading-relaxed">
                                {logOutput.length === 0 ? (
                                    <div className="text-center py-8">
                                        <svg className="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                                        </svg>
                                        <p className="text-gray-500 italic">No activity yet. Start a backup to see the logs.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-1">
                                        {logOutput.slice(-50).map((line, index) => (
                                            <div 
                                                key={index} 
                                                className="break-words text-left hover:bg-gray-800/50 px-2 py-1 rounded transition-colors duration-150 fade-in"
                                                style={{ animationDelay: `${index * 30}ms` }}
                                            >
                                                <span className="text-emerald-300">{line.substring(0, line.indexOf(']') + 1)}</span>
                                                <span className="text-gray-300">{line.substring(line.indexOf(']') + 1)}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                </div>
            )}

            {/* Create/Edit Backup Form */}
            {(showCreateForm || showEditForm) && (
                <section className="mb-8 px-4 py-6 bg-white/90 backdrop-blur rounded-xl border border-white/20 shadow-lg card fade-in">
                    <div className="flex items-center gap-3 mb-6">
                        <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        <h2 className="text-2xl font-semibold text-gray-800">
                            {showEditForm ? 'Edit Backup Configuration' : 'Create New Backup Configuration'}
                        </h2>
                    </div>
                    
                    <div className="space-y-6">
                        <div className="bg-gradient-to-br from-gray-50 to-white p-6 rounded-xl border border-gray-200">
                            <div className="mb-6">
                                <label htmlFor="backup-name" className="block mb-2 font-semibold text-gray-800 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                                    </svg>
                                    Backup Name:
                                </label>
                                <input
                                    id="backup-name"
                                    type="text"
                                    value={formBackupName}
                                    onChange={(e) => setFormBackupName(e.target.value)}
                                    placeholder="e.g., Documents Backup"
                                    className="focus-ring w-full px-4 py-3 border border-gray-300 rounded-lg text-base transition-all duration-200 bg-white text-gray-900"
                                />
                            </div>

                            <div className="mb-6">
                                <label htmlFor="schedule" className="block mb-2 font-semibold text-gray-800 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Schedule:
                                </label>
                                <select
                                    id="schedule"
                                    value={formSchedule}
                                    onChange={(e) => setFormSchedule(e.target.value)}
                                    className="focus-ring w-full px-4 py-3 border border-gray-300 rounded-lg text-base bg-white text-gray-900 transition-all duration-200"
                                >
                                    <option value="manual">Manual Only</option>
                                    <option value="hourly">Hourly</option>
                                    <option value="daily">Daily</option>
                                    <option value="weekly">Weekly</option>
                                    <option value="monthly">Monthly</option>
                                </select>
                            </div>

                            <div className="mb-6 bg-white p-6 rounded-xl border border-gray-200">
                                <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                    </svg>
                                    Source Directories
                                </h3>
                                <div className="min-h-[80px] max-h-[250px] overflow-y-auto border-2 border-dashed border-gray-300 rounded-lg p-4 bg-gray-50">
                                    {formSourcePaths.length === 0 ? (
                                        <div className="text-center py-8">
                                            <svg className="w-10 h-10 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                                            </svg>
                                            <p className="text-gray-500">No source directories added yet.</p>
                                            <p className="text-sm text-gray-400 mt-1">Click "Add Source" to select directories</p>
                                        </div>
                                    ) : (
                                        <ul className="space-y-2">
                                            {formSourcePaths.map((path, index) => (
                                                <li
                                                    key={path}
                                                    className={`p-3 bg-white border-2 rounded-lg cursor-pointer transition-all duration-200 break-all flex items-center gap-3 text-gray-900 ${
                                                        selectedSourceIndex === index 
                                                            ? 'border-primary-500 bg-primary-50 font-medium shadow-sm' 
                                                            : 'border-gray-200 hover:border-primary-300 hover:bg-gray-50'
                                                    }`}
                                                    onClick={() => setSelectedSourceIndex(index)}
                                                >
                                                    <svg className="w-4 h-4 text-primary-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                                                        <path stroke="currentColor" strokeWidth={1} d="M4 9v3a1 1 0 001 1h8a1 1 0 001-1V9a1 1 0 00-1-1H5a1 1 0 00-1 1z" fill="none" />
                                                    </svg>
                                                    {path}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div className="flex gap-3 mt-4">
                                    <button 
                                        onClick={handleFormAddSourcePath} 
                                        className="btn bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                        </svg>
                                        Add Source
                                    </button>
                                    <button 
                                        onClick={handleLoadCommonPaths} 
                                        className="btn bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                                        </svg>
                                        Common Paths
                                    </button>
                                    <button 
                                        onClick={handleFormRemoveSourcePath} 
                                        disabled={selectedSourceIndex === null} 
                                        className="btn bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                        Remove Selected
                                    </button>
                                </div>
                            </div>

                            <div className="mb-6 bg-white p-6 rounded-xl border border-gray-200">
                                <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L5.636 5.636" />
                                    </svg>
                                    Ignore Patterns
                                </h3>
                                <div className="min-h-[80px] max-h-[250px] overflow-y-auto border-2 border-dashed border-gray-300 rounded-lg p-4 bg-gray-50">
                                    {formIgnorePatterns.length === 0 ? (
                                        <div className="text-center py-8">
                                            <svg className="w-10 h-10 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                            </svg>
                                            <p className="text-gray-500">No ignore patterns defined.</p>
                                            <p className="text-sm text-gray-400 mt-1">Patterns help exclude files from backups</p>
                                        </div>
                                    ) : (
                                        <ul className="space-y-2">
                                            {formIgnorePatterns.map((pattern, index) => (
                                                <li
                                                    key={pattern}
                                                    className={`p-3 bg-white border-2 rounded-lg cursor-pointer transition-all duration-200 break-all flex items-center gap-3 text-gray-900 ${
                                                        selectedIgnoreIndex === index 
                                                            ? 'border-amber-500 bg-amber-50 font-medium shadow-sm' 
                                                            : 'border-gray-200 hover:border-amber-300 hover:bg-gray-50'
                                                    }`}
                                                    onClick={() => setSelectedIgnoreIndex(index)}
                                                >
                                                    <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L5.636 5.636" />
                                                    </svg>
                                                    {pattern}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div className="space-y-4">
                                    <div className="flex gap-3">
                                        <div className="flex-1">
                                            <input
                                                type="text"
                                                value={newIgnorePattern}
                                                onChange={(e) => setNewIgnorePattern(e.target.value)}
                                                onKeyPress={handleIgnorePatternKeyPress}
                                                placeholder="Enter ignore pattern (e.g., 'node_modules', '*.log', '.git')"
                                                className="focus-ring w-full px-4 py-3 border border-gray-300 rounded-lg text-base transition-all duration-200 bg-white text-gray-900"
                                            />
                                            <div className="mt-2 text-sm text-gray-600">
                                                <span className="font-medium">Examples:</span> node_modules/, *.tmp, .git, build/, src/*.test.js
                                            </div>
                                        </div>
                                        <button 
                                            onClick={handleFormAddIgnorePattern} 
                                            disabled={!newIgnorePattern.trim() || formIgnorePatterns.includes(newIgnorePattern.trim())}
                                            className="btn bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-medium py-3 px-6 rounded-lg transition-all duration-200 shadow hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                            </svg>
                                            Add Pattern
                                        </button>
                                    </div>
                                    <div className="flex gap-3">
                                        <button 
                                            onClick={handleFormRemoveIgnorePattern} 
                                            disabled={selectedIgnoreIndex === null} 
                                            className="btn bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                            Remove Selected
                                        </button>
                                        <button 
                                            onClick={handleFormProposeIgnores} 
                                            className="btn bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white font-medium py-2.5 px-5 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                            </svg>
                                            Propose Defaults
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="mb-6 bg-white p-6 rounded-xl border border-gray-200">
                                <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-primary-600" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                                        <path stroke="currentColor" strokeWidth={1} d="M4 9v3a1 1 0 001 1h8a1 1 0 001-1V9a1 1 0 00-1-1H5a1 1 0 00-1 1z" fill="none" />
                                    </svg>
                                    Backup Destination
                                </h3>
                                <div className="flex gap-3 items-center">
                                    <div className="flex-1 relative">
                                        <input
                                            type="text"
                                            value={formDestinationPath || 'No destination selected'}
                                            readOnly
                                            className="focus-ring w-full px-4 py-3 pr-10 border border-gray-300 rounded-lg text-base bg-gray-50 text-gray-700 cursor-not-allowed"
                                        />
                                        <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                                            {formDestinationPath ? (
                                                <svg className="w-5 h-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                                </svg>
                                            ) : (
                                                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                </svg>
                                            )}
                                        </div>
                                    </div>
                                    <button 
                                        onClick={handleFormSelectDestination} 
                                        className="btn bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white font-medium py-3 px-6 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2 whitespace-nowrap"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                                        </svg>
                                        Select Destination
                                    </button>
                                </div>
                            </div>

                        <div className="flex gap-3 justify-end pt-6 border-t border-gray-200">
                            <button 
                                onClick={handleSaveBackup} 
                                className="btn bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white font-semibold py-3 px-8 rounded-lg transition-all duration-200 shadow hover:shadow-lg transform hover:scale-105 flex items-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                {showEditForm ? 'Update Backup' : 'Create Backup'}
                            </button>
                            <button 
                                onClick={handleCancelForm} 
                                className="btn bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 text-white font-semibold py-3 px-8 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
                </section>
            )}

            {/* Common Paths Modal */}
            {showCommonPaths && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center items-center z-50 p-4 fade-in" onClick={() => setShowCommonPaths(false)}>
                    <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col transform transition-all duration-300 scale-100" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gradient-to-r from-primary-50 to-indigo-50 rounded-t-2xl">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-primary-600 rounded-lg flex items-center justify-center">
                                    <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                                    </svg>
                                </div>
                                <h3 className="text-xl font-bold text-gray-800">Common Backup Paths</h3>
                            </div>
                            <button 
                                className="bg-transparent border-none text-2xl cursor-pointer text-gray-500 hover:text-gray-700 p-2 w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors duration-200" 
                                onClick={() => setShowCommonPaths(false)}
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <div className="p-6 overflow-y-auto flex-1">
                            {commonPaths.length === 0 ? (
                                <div className="text-center py-12">
                                    <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                                    </svg>
                                    <p className="text-gray-600 text-lg">No common paths found</p>
                                    <p className="text-gray-500 mt-2">We couldn't find any common backup directories on your system</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <p className="text-gray-600 mb-4">Select paths to add to your backup configuration:</p>
                                    <ul className="space-y-3">
                                        {commonPaths.map((path, index) => (
                                            <li 
                                                key={index} 
                                                className="flex justify-between items-center p-4 bg-gray-50 border-2 border-gray-200 rounded-xl hover:border-primary-300 hover:bg-primary-50 transition-all duration-200 group"
                                            >
                                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                                    <svg className="w-5 h-5 text-primary-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                                                        <path stroke="currentColor" strokeWidth={1} d="M4 9v3a1 1 0 001 1h8a1 1 0 001-1V9a1 1 0 00-1-1H5a1 1 0 00-1 1z" fill="none" />
                                                    </svg>
                                                    <span className="font-mono text-sm text-gray-700 break-all">{path}</span>
                                                </div>
                                                <button 
                                                    className={`btn py-2 px-4 rounded-lg font-medium transition-all duration-200 flex items-center gap-2 min-w-[100px] justify-center ${
                                                        formSourcePaths.includes(path) 
                                                            ? 'bg-emerald-500 text-white cursor-not-allowed' 
                                                            : 'bg-primary-600 hover:bg-primary-700 text-white shadow hover:shadow-lg'
                                                    }`}
                                                    onClick={() => handleAddCommonPath(path)}
                                                    disabled={formSourcePaths.includes(path)}
                                                >
                                                    {formSourcePaths.includes(path) ? (
                                                        <>
                                                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                                            </svg>
                                                            Added
                                                        </>
                                                    ) : (
                                                        <>
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                                            </svg>
                                                            Add Path
                                                        </>
                                                    )}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                        <div className="p-6 border-t border-gray-200 bg-gray-50 rounded-b-2xl flex justify-end">
                            <button 
                                className="btn bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-8 rounded-lg transition-all duration-200 shadow hover:shadow-lg flex items-center gap-2" 
                                onClick={() => setShowCommonPaths(false)}
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
            </div>
            </div>
        </div>
    );
}

export default BackupApp;
