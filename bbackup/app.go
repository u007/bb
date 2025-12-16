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
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		backupState: nil,
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Greet called with name: %s", name))
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
	config := &BackupConfig{
		ID:              fmt.Sprintf("backup_%d", time.Now().Unix()),
		SourcePaths:     sourcePaths,
		DestinationPath: casBaseDir,
		IgnorePatterns:  ignorePatterns,
	}
	
	go a.runBackupWithResume(config, false)
}

// runBackupWithResume runs a backup with optional resume capability
func (a *App) runBackupWithResume(config *BackupConfig, resume bool) {
	a.backupMutex.Lock()
	
	// Check for existing backup state on startup
	if !resume {
		// Try to load existing state for this destination
		existingState, err := a.loadBackupState(config.DestinationPath)
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Warning: Failed to load existing backup state: %v", err))
		} else if existingState != nil {
			// Found existing state, ask user if they want to resume
			wailsruntime.EventsEmit(a.ctx, "app:backup:resumable", "Found interrupted backup")
		}
	}
	
	// Initialize backup state
	backupID := config.ID
	if resume && a.backupState != nil {
		// Use existing state
		a.backupState.Status = "running"
		a.backupState.LastUpdateTime = time.Now()
		backupID = a.backupState.ID
	} else {
		// Create new state
		a.backupState = &BackupState{
			ID:             backupID,
			Status:         "running",
			Config:         *config,
			StartTime:      time.Now(),
			LastUpdateTime: time.Now(),
			ProcessedFiles: make(map[string]bool),
		}
	}
	
	a.backupMutex.Unlock()
	
	wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Backup process started (ID: %s)...", backupID))
	wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Running")

	// Basic validation
	if config.DestinationPath == "" {
		wailsruntime.EventsEmit(a.ctx, "app:log", "Error: Backup destination not set.")
		wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
		return
	}
	if len(config.SourcePaths) == 0 {
		wailsruntime.EventsEmit(a.ctx, "app:log", "Error: No source paths selected for backup.")
		wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
		return
	}

	// Ensure the CAS root exists
	if err := os.MkdirAll(config.DestinationPath, 0755); err != nil {
		wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Error creating CAS base directory: %s", err.Error()))
		wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
		return
	}

	// Create a context for cancellation
	backupCtx, cancel := context.WithCancel(a.ctx)
	
	// Store cancel function for stop/pause operations
	a.backupMutex.Lock()
	a.backupCancel = cancel
	a.backupMutex.Unlock()

	defer func() {
		a.backupMutex.Lock()
		a.backupCancel = nil
		a.backupMutex.Unlock()
	}()

	// Progress callback function with state tracking
	progressCb := func(progress backend.BackupProgress) {
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
		
		// Only log meaningful status changes, not every progress update
		if progress.Status != "" && !strings.Contains(progress.Status, "Processing file") {
			if progress.CurrentFile != "" {
				wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("%s %s", progress.Status, progress.CurrentFile))
			} else {
				wailsruntime.EventsEmit(a.ctx, "app:log", progress.Status)
			}
		}
		
		// Emit progress for frontend
		jsonProgress, err := json.Marshal(progress)
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Error marshalling progress: %v", err))
			return
		}
		wailsruntime.EventsEmit(a.ctx, "app:backup:progress", string(jsonProgress))
		
		// Save state periodically
		a.backupMutex.Lock()
		if a.backupState != nil {
			a.saveBackupState()
		}
		a.backupMutex.Unlock()
	}

	err := backend.RunBackup(backupCtx, config.DestinationPath, config.SourcePaths, config.IgnorePatterns, progressCb)
	
	// Update final state
	a.backupMutex.Lock()
	if a.backupState != nil {
		a.backupState.LastUpdateTime = time.Now()
		if err != nil {
			if err == context.Canceled {
				// Status already set by StopBackup/PauseBackup
			} else {
				a.backupState.Status = "failed"
				wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
			}
		} else {
			a.backupState.Status = "completed"
			// Clean up state file on successful completion
			stateFile := filepath.Join(config.DestinationPath, ".backup_state.json")
			os.Remove(stateFile)
			wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Completed")
		}
		a.saveBackupState()
	}
	a.backupMutex.Unlock()
	
	if err != nil {
		wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Backup %s: %s", backupID, err.Error()))
		if err != context.Canceled {
			wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
		}
	} else {
		wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Backup %s completed successfully.", backupID))
		wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Completed")
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
	defer a.backupMutex.Unlock()
	
	if a.backupState == nil || a.backupCancel == nil {
		return fmt.Errorf("no backup operation in progress")
	}
	
	if a.backupState.Status != "running" {
		return fmt.Errorf("backup is not running (current status: %s)", a.backupState.Status)
	}
	
	// Cancel the backup
	a.backupCancel()
	a.backupState.Status = "stopped"
	a.backupState.LastUpdateTime = time.Now()
	
	// Save the state for potential resume
	err := a.saveBackupState()
	if err != nil {
		wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Warning: Failed to save backup state: %v", err))
	}
	
	wailsruntime.EventsEmit(a.ctx, "app:log", "Backup stopped by user")
	wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Stopped")
	
	return nil
}

// PauseBackup pauses the current backup operation
func (a *App) PauseBackup() error {
	a.backupMutex.Lock()
	defer a.backupMutex.Unlock()
	
	if a.backupState == nil {
		return fmt.Errorf("no backup operation in progress")
	}
	
	if a.backupState.Status != "running" {
		return fmt.Errorf("backup is not running (current status: %s)", a.backupState.Status)
	}
	
	// Cancel the backup
	a.backupCancel()
	a.backupState.Status = "paused"
	a.backupState.LastUpdateTime = time.Now()
	
	// Save the state for resume
	err := a.saveBackupState()
	if err != nil {
		wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Warning: Failed to save backup state: %v", err))
	}
	
	wailsruntime.EventsEmit(a.ctx, "app:log", "Backup paused")
	wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Paused")
	
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
