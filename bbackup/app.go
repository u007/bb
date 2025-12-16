package main

import (
	"context"
	"encoding/json" // Added for JSON encoding
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"bbackup/backend"
)

// BackupState represents the current state of a backup operation
type BackupState struct {
	ID              string            `json:"id"`
	Status          string            `json:"status"` // "running", "paused", "stopped", "completed", "failed"
	Progress        backend.BackupProgress `json:"progress"`
	Config          BackupConfig      `json:"config"`
	StartTime       time.Time         `json:"startTime"`
	LastUpdateTime  time.Time         `json:"lastUpdateTime"`
	ProcessedFiles  map[string]bool   `json:"processedFiles"` // Track completed files for resume
	CurrentFile     string            `json:"currentFile"`
}

// BackupConfig represents a backup configuration
type BackupConfig struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	SourcePaths     []string `json:"sourcePaths"`
	DestinationPath string   `json:"destinationPath"`
	IgnorePatterns  []string `json:"ignorePatterns"`
}

// App struct
type App struct {
	ctx            context.Context
	backupState    *BackupState
	backupCancel   context.CancelFunc
	backupMutex    sync.RWMutex
	eventQueue     chan eventMessage
}

type eventMessage struct {
	name string
	data interface{}
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		backupState: nil,
		eventQueue:  make(chan eventMessage, 1000),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	
	// Start event emitter goroutine
	go a.eventEmitter()
	
	// Check for any interrupted backups and restore state
	go a.checkAndRestoreInterruptedBackups()
}

// eventEmitter runs in a separate goroutine and emits queued events
func (a *App) eventEmitter() {
	fmt.Fprintf(os.Stderr, "DEBUG: Event emitter goroutine started\n")
	for msg := range a.eventQueue {
		if a.ctx == nil {
			fmt.Fprintf(os.Stderr, "WARNING: Context not initialized, skipping event: %s\n", msg.name)
			continue
		}
		fmt.Fprintf(os.Stderr, "DEBUG: Emitting event: %s\n", msg.name)
		wailsruntime.EventsEmit(a.ctx, msg.name, msg.data)
		fmt.Fprintf(os.Stderr, "DEBUG: Event emitted: %s\n", msg.name)
	}
	fmt.Fprintf(os.Stderr, "DEBUG: Event emitter goroutine exited\n")
}

// emitEvent queues an event for emission (non-blocking)
func (a *App) emitEvent(name string, data interface{}) {
	select {
	case a.eventQueue <- eventMessage{name: name, data: data}:
		// Event queued successfully
	default:
		// Queue is full, log but don't block
		fmt.Fprintf(os.Stderr, "WARNING: Event queue full, dropping event: %s\n", name)
	}
}

// checkAndRestoreInterruptedBackups looks for any backup state files and restores them
func (a *App) checkAndRestoreInterruptedBackups() {
	// Get suggested destination paths or use common locations
	homeDir, err := os.UserHomeDir()
	if err != nil {
		a.emitEvent("app:log", "Warning: Could not determine home directory")
		return
	}
	
	// Common backup destinations to check
	commonDests := []string{
		filepath.Join(homeDir, "Backups"),
		filepath.Join(homeDir, "backup"),
		filepath.Join(homeDir, "bbackup"),
	}
	
	for _, dest := range commonDests {
		if state, err := a.loadBackupState(dest); err == nil && state != nil {
			// Found an interrupted backup
			a.backupMutex.Lock()
			a.backupState = state
			a.backupMutex.Unlock()
			
			a.emitEvent("app:log", fmt.Sprintf("Found interrupted backup in %s", dest))
			a.emitEvent("app:backup:resumable", fmt.Sprintf("Interrupted backup found in %s", dest))
			a.emitEvent("app:backup:status", state.Status)
			
			// Send current progress to frontend
			jsonProgress, err := json.Marshal(state.Progress)
			if err == nil {
				a.emitEvent("app:backup:progress", string(jsonProgress))
			}
			
			break // Only restore the first one found
		}
	}
}

// CheckAllBackupStates checks all possible backup destinations for running backups
func (a *App) CheckAllBackupStates() map[string]*BackupState {
	result := make(map[string]*BackupState)
	
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return result
	}
	
	// Check common backup destinations
	commonDests := []string{
		filepath.Join(homeDir, "Backups"),
		filepath.Join(homeDir, "backup"),
		filepath.Join(homeDir, "bbackup"),
	}
	
	for _, dest := range commonDests {
		if state, err := a.loadBackupState(dest); err == nil && state != nil {
			result[dest] = state
		}
	}
	
	return result
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	a.emitEvent("app:log", fmt.Sprintf("Greet called with name: %s", name))
	return fmt.Sprintf("Hello %s, It's show time!", name)
}

// GetSuggestedBackupPaths returns a list of common user directories to suggest for backup.
func (a *App) GetSuggestedBackupPaths() ([]string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get user home directory: %w", err)
	}

	var suggestions []string

	// Common directories
	commonDirs := []string{"Documents", "Downloads", "Pictures", "Desktop"}

	for _, dir := range commonDirs {
		fullPath := filepath.Join(homeDir, dir)
		if _, err := os.Stat(fullPath); err == nil {
			suggestions = append(suggestions, fullPath)
		}
	}

	// Add special macOS directories
	if runtime.GOOS == "darwin" {
		macOSDirs := []string{"Movies", "Music", "Public"}
		for _, dir := range macOSDirs {
			fullPath := filepath.Join(homeDir, dir)
			if _, err := os.Stat(fullPath); err == nil {
				suggestions = append(suggestions, fullPath)
			}
		}
	}

	return suggestions, nil
}

// GetSuggestedIgnorePatterns returns a list of common patterns to ignore.
func (a *App) GetSuggestedIgnorePatterns() []string {
	return []string{
		// Development and build directories
		"dist/",
		"build/",
		"node_modules/",
		".next/",
		".nuxt/",
		".output/",
		".cache/",
		".turbo/",
		".vercel/",
		".netlify/",
		
		// Version control
		".git/",
		".svn/",
		".hg/",
		".gitignore",
		
		// Platform-specific files
		".DS_Store",          // macOS
		"Thumbs.db",           // Windows
		"desktop.ini",         // Windows
		".Spotlight-V100",     // macOS
		".Trashes",            // macOS
		"fseventsd",           // macOS
		"._*",                 // macOS resource forks
		
		// Logs and temporary files
		"coverage/",
		"tmp/",
		"logs/",
		"*.log",
		"*.tmp",
		"*.bak",
		"*.swp",
		"*.swo",
		"*~",
		
		// Package manager caches
		".pnpm-store/",
		".npm/",
		".yarn/",
		".pnpm/",
		"package-lock.json",
		"yarn.lock",
		"pnpm-lock.yaml",
		
		// Home directory specific ignores (common development directories)
		"~/.nvm/",
		"~/.bun/",
		"~/.pnpm-store/",
		
		// Python
		"__pycache__/",
		"*.pyc",
		"*.pyo",
		"*.pyd",
		".Python",
		"pip-log.txt",
		"pip-delete-this-directory.txt",
		
		// Node.js
		".npmrc",
		".node_repl_history",
		".yarn-integrity",
		".env.local",
		".env.development.local",
		".env.test.local",
		".env.production.local",
		
		// IDE and editor files
		".vscode/",
		".idea/",
		".vs/",
		"*.sublime-*",
		".editorconfig",
		
		// OS generated files
		"ehthumbs.db",
		"Desktop.ini",
		"$RECYCLE.BIN/",
		
		// Virtual environments
		"venv/",
		"env/",
		".venv/",
		".env/",
		"virtualenv/",
		
		// CI/CD
		".github/",
		".gitlab-ci.yml",
		".travis.yml",
		".circleci/",
	}
}

// SelectSourceDirectory opens a directory selection dialog for source directories
func (a *App) SelectSourceDirectory() (string, error) {
	selection, err := wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Select Source Directory",
	})
	if err != nil {
		return "", fmt.Errorf("failed to open directory dialog: %w", err)
	}
	return selection, nil
}

// SelectDestinationDirectory opens a directory selection dialog for destination
func (a *App) SelectDestinationDirectory() (string, error) {
	selection, err := wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Select Backup Destination",
	})
	if err != nil {
		return "", fmt.Errorf("failed to open directory dialog: %w", err)
	}
	return selection, nil
}

// StartBackup initiates the backup process.
// It runs in a goroutine to avoid blocking the main thread.
func (a *App) StartBackup(casBaseDir string, sourcePaths []string, ignorePatterns []string) {
	fmt.Fprintf(os.Stderr, "DEBUG: StartBackup called with casBaseDir=%s, sourcePaths=%v\n", casBaseDir, sourcePaths)
	
	// Check if backup is already running
	fmt.Fprintf(os.Stderr, "DEBUG: Checking if backup already running\n")
	a.backupMutex.Lock()
	if a.backupState != nil && (a.backupState.Status == "running" || a.backupState.Status == "paused") {
		a.backupMutex.Unlock()
		fmt.Fprintf(os.Stderr, "DEBUG: Backup already in progress\n")
		a.emitEvent("app:log", "Backup already in progress")
		a.emitEvent("app:backup:status", "Already Running")
		return
	}
	
	fmt.Fprintf(os.Stderr, "DEBUG: Creating backup config\n")
	config := &BackupConfig{
		ID:              fmt.Sprintf("backup_%d", time.Now().Unix()),
		SourcePaths:     sourcePaths,
		DestinationPath: casBaseDir,
		IgnorePatterns:  ignorePatterns,
	}
	fmt.Fprintf(os.Stderr, "DEBUG: Backup config created: ID=%s\n", config.ID)
	
	// Set backup state to running IMMEDIATELY to prevent race conditions
	a.backupState = &BackupState{
		ID:             config.ID,
		Status:         "running",
		Config:         *config,
		StartTime:      time.Now(),
		LastUpdateTime: time.Now(),
		ProcessedFiles: make(map[string]bool),
	}
	a.backupMutex.Unlock()
	fmt.Fprintf(os.Stderr, "DEBUG: Backup state set to running before goroutine\n")
	
	// Run backup in background goroutine
	fmt.Fprintf(os.Stderr, "DEBUG: Starting backup goroutine\n")
	go func() {
		fmt.Fprintf(os.Stderr, "DEBUG: Backup goroutine started\n")
		// Recover from any panics to prevent crashing the entire app
		defer func() {
			fmt.Fprintf(os.Stderr, "DEBUG: Backup goroutine defer function called\n")
			if r := recover(); r != nil {
				fmt.Fprintf(os.Stderr, "DEBUG: Backup panic recovered: %v\n", r)
				a.emitEvent("app:log", fmt.Sprintf("Backup panic recovered: %v", r))
				a.emitEvent("app:backup:status", "Failed")
				a.backupMutex.Lock()
				a.backupState = nil
				a.backupCancel = nil
				a.backupMutex.Unlock()
			}
		}()
		
		fmt.Fprintf(os.Stderr, "DEBUG: About to call runBackupWithResume\n")
		a.runBackupWithResume(config, false)
		fmt.Fprintf(os.Stderr, "DEBUG: runBackupWithResume returned\n")
	}()
	fmt.Fprintf(os.Stderr, "DEBUG: StartBackup function completed\n")
}

// runBackupWithResume runs a backup with optional resume capability
func (a *App) runBackupWithResume(config *BackupConfig, resume bool) {
	fmt.Fprintf(os.Stderr, "DEBUG: runBackupWithResume called with resume=%v\n", resume)
	a.backupMutex.Lock()
	fmt.Fprintf(os.Stderr, "DEBUG: Acquired backup mutex lock\n")
	
	// Check for existing backup state on startup
	if !resume {
		fmt.Fprintf(os.Stderr, "DEBUG: Checking for existing backup state\n")
		// Try to load existing state for this destination
		existingState, err := a.loadBackupState(config.DestinationPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to load existing backup state: %v\n", err)
			a.emitEvent("app:log", fmt.Sprintf("Warning: Failed to load existing backup state: %v", err))
		} else if existingState != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Found existing backup state, will ask user to resume\n")
			// Found existing state, ask user if they want to resume
			a.emitEvent("app:backup:resumable", "Found interrupted backup")
		}
	}
	
	// Backup state is already set in StartBackup, just verify it exists
	backupID := config.ID
	fmt.Fprintf(os.Stderr, "DEBUG: Verifying backup state exists with ID=%s\n", backupID)
	if a.backupState == nil {
		fmt.Fprintf(os.Stderr, "DEBUG: ERROR: Backup state is nil!\n")
		a.emitEvent("app:log", "Error: Backup state not initialized")
		a.emitEvent("app:backup:status", "Failed")
		a.backupMutex.Unlock()
		return
	}
	
	fmt.Fprintf(os.Stderr, "DEBUG: About to release backup mutex lock\n")
	a.backupMutex.Unlock()
	fmt.Fprintf(os.Stderr, "DEBUG: Released backup mutex lock\n")
	
	fmt.Fprintf(os.Stderr, "DEBUG: About to emit events\n")
	a.emitEvent("app:log", fmt.Sprintf("Backup process started (ID: %s)...", backupID))
	a.emitEvent("app:backup:status", "Running")
	// Give goroutines a moment to start
	time.Sleep(10 * time.Millisecond)
	fmt.Fprintf(os.Stderr, "DEBUG: Events emitted (goroutines started)\n")

	// Basic validation
	fmt.Fprintf(os.Stderr, "DEBUG: Starting validation\n")
	if config.DestinationPath == "" {
		fmt.Fprintf(os.Stderr, "DEBUG: Destination path is empty\n")
		a.emitEvent("app:log", "Error: Backup destination not set.")
		a.emitEvent("app:backup:status", "Failed")
		return
	}
	if len(config.SourcePaths) == 0 {
		fmt.Fprintf(os.Stderr, "DEBUG: No source paths provided\n")
		a.emitEvent("app:log", "Error: No source paths selected for backup.")
		a.emitEvent("app:backup:status", "Failed")
		return
	}
	fmt.Fprintf(os.Stderr, "DEBUG: Validation passed, about to create directory\n")

	// Ensure the CAS root exists with timeout
	fmt.Fprintf(os.Stderr, "DEBUG: About to create directory: %s\n", config.DestinationPath)
	
	// Use a goroutine to implement timeout for directory creation
	type mkdirResult struct {
		err error
	}
	
	resultChan := make(chan mkdirResult, 1)
	go func() {
		err := os.MkdirAll(config.DestinationPath, 0755)
		resultChan <- mkdirResult{err: err}
	}()
	
	// Wait for result with timeout
	select {
	case result := <-resultChan:
		if result.err != nil {
			a.emitEvent("app:log", fmt.Sprintf("Error creating CAS base directory: %s", result.err.Error()))
			a.emitEvent("app:backup:status", "Failed")
			return
		}
		fmt.Fprintf(os.Stderr, "DEBUG: Directory created successfully\n")
	case <-time.After(10 * time.Second):
		a.emitEvent("app:log", "Timeout creating CAS base directory - network volume may be unavailable")
		a.emitEvent("app:backup:status", "Failed")
		return
	}

	// Create a context for cancellation
	fmt.Fprintf(os.Stderr, "DEBUG: About to create backup context\n")
	backupCtx, cancel := context.WithCancel(a.ctx)
	fmt.Fprintf(os.Stderr, "DEBUG: Backup context created\n")
	
	// Store cancel function for stop/pause operations
	fmt.Fprintf(os.Stderr, "DEBUG: About to store cancel function\n")
	a.backupMutex.Lock()
	a.backupCancel = cancel
	a.backupMutex.Unlock()
	fmt.Fprintf(os.Stderr, "DEBUG: Cancel function stored\n")

	defer func() {
		fmt.Fprintf(os.Stderr, "DEBUG: Defer function called - cleaning up cancel\n")
		a.backupMutex.Lock()
		a.backupCancel = nil
		a.backupMutex.Unlock()
	}()

	// Progress callback function with state tracking
	fmt.Fprintf(os.Stderr, "DEBUG: About to create progress callback\n")
	progressCb := func(progress backend.BackupProgress) {
		// Check if backup was cancelled before processing progress
		a.backupMutex.RLock()
		if a.backupState != nil && a.backupState.Status == "paused" {
			a.backupMutex.RUnlock()
			return
		}
		if a.backupState != nil && a.backupState.Status == "stopped" {
			a.backupMutex.RUnlock()
			return
		}
		a.backupMutex.RUnlock()
		
		// Update state
		a.backupMutex.Lock()
		if a.backupState != nil {
			a.backupState.Progress = progress
			a.backupState.LastUpdateTime = time.Now()
			if progress.CurrentFile != "" {
				a.backupState.CurrentFile = progress.CurrentFile
				// Mark file as processed for resume capability
				a.backupState.ProcessedFiles[progress.CurrentFile] = true
			}
		}
		a.backupMutex.Unlock()
		
		// Emit events in a non-blocking goroutine to prevent deadlocks
		go func() {
			// Only log meaningful status changes, not every progress update
			if progress.Status != "" && !strings.Contains(progress.Status, "Processing file") {
				if progress.CurrentFile != "" {
					a.emitEvent("app:log", fmt.Sprintf("%s %s", progress.Status, progress.CurrentFile))
				} else {
					a.emitEvent("app:log", progress.Status)
				}
			}
			
			// Emit progress for frontend
			jsonProgress, err := json.Marshal(progress)
			if err != nil {
				a.emitEvent("app:log", fmt.Sprintf("Error marshalling progress: %v", err))
				return
			}
			a.emitEvent("app:backup:progress", string(jsonProgress))
		}()
		
		// Save state periodically
		a.backupMutex.Lock()
		var stateToCopy *BackupState
		if a.backupState != nil {
			// Make a copy while holding the lock
			copy := *a.backupState
			stateToCopy = &copy
		}
		a.backupMutex.Unlock()
		
		// Save outside the mutex to avoid deadlock
		if stateToCopy != nil {
			stateFile := filepath.Join(stateToCopy.Config.DestinationPath, ".backup_state.json")
			data, err := json.MarshalIndent(stateToCopy, "", "  ")
			if err == nil {
				os.WriteFile(stateFile, data, 0644)
			}
		}
	}

	fmt.Fprintf(os.Stderr, "DEBUG: About to call backend.RunBackup\n")
	err := backend.RunBackup(backupCtx, config.DestinationPath, config.SourcePaths, config.IgnorePatterns, progressCb)
	fmt.Fprintf(os.Stderr, "DEBUG: backend.RunBackup returned with err=%v\n", err)
	
	// Update final state
	a.backupMutex.Lock()
	if a.backupState != nil {
		a.backupState.LastUpdateTime = time.Now()
		if err != nil {
			if err == context.Canceled {
				// Status already set by StopBackup/PauseBackup
			} else {
				a.backupState.Status = "failed"
				a.emitEvent("app:backup:status", "Failed")
			}
		} else {
			a.backupState.Status = "completed"
			// Clean up state file on successful completion
			stateFile := filepath.Join(config.DestinationPath, ".backup_state.json")
			os.Remove(stateFile)
			a.emitEvent("app:backup:status", "Completed")
		}
		a.saveBackupState()
	}
	a.backupMutex.Unlock()
	
	if err != nil {
		a.emitEvent("app:log", fmt.Sprintf("Backup %s: %s", backupID, err.Error()))
		if err != context.Canceled {
			a.emitEvent("app:backup:status", "Failed")
		}
	} else {
		a.emitEvent("app:log", fmt.Sprintf("Backup %s completed successfully.", backupID))
		a.emitEvent("app:backup:status", "Completed")
	}
}

// GetSystemInfo returns system information that might be useful for backup configuration
func (a *App) GetSystemInfo() (map[string]interface{}, error) {
	info := make(map[string]interface{})
	
	// Get OS information
	info["os"] = runtime.GOOS
	info["arch"] = runtime.GOARCH
	
	// Get home directory
	homeDir, err := os.UserHomeDir()
	if err != nil {
		info["homeDir"] = "Unknown"
	} else {
		info["homeDir"] = homeDir
	}
	
	// Get current working directory
	cwd, err := os.Getwd()
	if err != nil {
		info["currentDir"] = "Unknown"
	} else {
		info["currentDir"] = cwd
	}
	
	return info, nil
}

// ValidateBackupPath checks if a path is valid for backup
func (a *App) ValidateBackupPath(path string) (bool, error) {
	// Check if path exists
	_, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil // Path doesn't exist
		}
		return false, err // Other error
	}
	
	// Check if it's readable
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	file.Close()
	
	return true, nil
}

// saveBackupState saves the current backup state to disk
func (a *App) saveBackupState() error {
	a.backupMutex.RLock()
	if a.backupState == nil {
		a.backupMutex.RUnlock()
		return nil
	}
	
	// Create a copy to avoid long lock times
	stateCopy := *a.backupState
	stateFile := filepath.Join(a.backupState.Config.DestinationPath, ".backup_state.json")
	a.backupMutex.RUnlock()
	
	data, err := json.MarshalIndent(stateCopy, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal backup state: %w", err)
	}
	
	return os.WriteFile(stateFile, data, 0644)
}

// loadBackupState loads backup state from disk
func (a *App) loadBackupState(destinationPath string) (*BackupState, error) {
	stateFile := filepath.Join(destinationPath, ".backup_state.json")
	data, err := os.ReadFile(stateFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // No existing state
		}
		return nil, fmt.Errorf("failed to read backup state file: %w", err)
	}
	
	var state BackupState
	err = json.Unmarshal(data, &state)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal backup state: %w", err)
	}
	
	return &state, nil
}

// getBackupState returns the current backup state (thread-safe)
func (a *App) GetBackupState() *BackupState {
	a.backupMutex.RLock()
	defer a.backupMutex.RUnlock()
	
	if a.backupState == nil {
		return nil
	}
	
	// Return a copy to avoid race conditions
	stateCopy := *a.backupState
	return &stateCopy
}

// StopBackup stops the current backup operation
func (a *App) StopBackup() error {
	a.backupMutex.Lock()
	
	if a.backupState == nil || a.backupCancel == nil {
		a.backupMutex.Unlock()
		return fmt.Errorf("no backup operation in progress")
	}
	
	if a.backupState.Status != "running" {
		a.backupMutex.Unlock()
		return fmt.Errorf("backup is not running (current status: %s)", a.backupState.Status)
	}
	
	// Cancel the backup
	a.backupCancel()
	a.backupState.Status = "stopped"
	a.backupState.LastUpdateTime = time.Now()
	
	// Save the state for potential resume
	err := a.saveBackupState()
	a.backupMutex.Unlock()
	
	if err != nil {
		a.emitEvent("app:log", fmt.Sprintf("Warning: Failed to save backup state: %v", err))
	}
	
	a.emitEvent("app:log", "Backup stopped by user")
	a.emitEvent("app:backup:status", "Stopped")
	
	return nil
}

// PauseBackup pauses the current backup operation
func (a *App) PauseBackup() error {
	a.backupMutex.Lock()
	
	if a.backupState == nil {
		a.backupMutex.Unlock()
		return fmt.Errorf("no backup operation in progress")
	}
	
	if a.backupState.Status != "running" {
		a.backupMutex.Unlock()
		return fmt.Errorf("backup is not running (current status: %s)", a.backupState.Status)
	}
	
	// Store the current file being processed before canceling
	currentFile := a.backupState.CurrentFile
	
	// Cancel the backup
	a.backupCancel()
	a.backupState.Status = "paused"
	a.backupState.LastUpdateTime = time.Now()
	
	// Save the state for resume
	err := a.saveBackupState()
	a.backupMutex.Unlock()
	
	if err != nil {
		a.emitEvent("app:log", fmt.Sprintf("Warning: Failed to save backup state: %v", err))
	}
	
	if currentFile != "" {
		a.emitEvent("app:log", fmt.Sprintf("Backup paused while processing: %s", currentFile))
	} else {
		a.emitEvent("app:log", "Backup paused")
	}
	a.emitEvent("app:backup:status", "Paused")
	
	return nil
}

// ResumeBackup resumes a paused or stopped backup
func (a *App) ResumeBackup() error {
	a.backupMutex.Lock()
	defer a.backupMutex.Unlock()
	
	if a.backupState == nil {
		return fmt.Errorf("no backup state available to resume")
	}
	
	if a.backupState.Status != "paused" && a.backupState.Status != "stopped" {
		return fmt.Errorf("backup cannot be resumed from status: %s", a.backupState.Status)
	}
	
	// Extract config from state
	config := a.backupState.Config
	
	// Start the backup with resume capability
	go a.runBackupWithResume(&config, true)
	
	return nil
}

// RestartBackup restarts a backup from the beginning
func (a *App) RestartBackup(config *BackupConfig) error {
	a.backupMutex.Lock()
	defer a.backupMutex.Unlock()
	
	// Stop any existing backup
	if a.backupCancel != nil {
		a.backupCancel()
	}
	
	// Clear any existing state
	a.backupState = nil
	
	// Start fresh backup
	go a.runBackupWithResume(config, false)
	
	return nil
}
