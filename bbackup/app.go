package main

import (
	"context"
	"encoding/json" // Added for JSON encoding
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"bbackup/backend"
)

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
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
		"node_modules",
		".DS_Store",
		"Thumbs.db",
		"*.tmp",
		"*.log",
		"*.bak",
		"*.swp",
		".git",
		".svn",
		".hg",
		"__pycache__",
		"*.pyc",
	}
}

// StartBackup initiates the backup process.
// It runs in a goroutine to avoid blocking the main thread.
func (a *App) StartBackup(casBaseDir string, sourcePaths []string, ignorePatterns []string) {
	go func() {
		wailsruntime.EventsEmit(a.ctx, "app:log", "Backup process started...")
		wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Running")

		// Basic validation
		if casBaseDir == "" {
			wailsruntime.EventsEmit(a.ctx, "app:log", "Error: Backup destination not set.")
			wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
			return
		}
		if len(sourcePaths) == 0 {
			wailsruntime.EventsEmit(a.ctx, "app:log", "Error: No source paths selected for backup.")
			wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
			return
		}

		// Ensure the CAS root exists
		if err := os.MkdirAll(casBaseDir, 0755); err != nil {
			wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Error creating CAS base directory: %s", err.Error()))
			wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
			return
		}

		// Create a context for cancellation
		backupCtx, cancel := context.WithCancel(a.ctx)
		defer cancel()

		// Progress callback function
		progressCb := func(progress backend.BackupProgress) {
			jsonProgress, err := json.Marshal(progress)
			if err != nil {
				wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Error marshalling progress: %v", err))
				return
			}
			wailsruntime.EventsEmit(a.ctx, "app:backup:progress", string(jsonProgress))
		}

		err := backend.RunBackup(backupCtx, casBaseDir, sourcePaths, ignorePatterns, progressCb)
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "app:log", fmt.Sprintf("Backup failed: %s", err.Error()))
			if err == context.Canceled {
				wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Cancelled")
			} else {
				wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Failed")
			}
		} else {
			wailsruntime.EventsEmit(a.ctx, "app:log", "Backup completed successfully.")
			wailsruntime.EventsEmit(a.ctx, "app:backup:status", "Completed")
		}
	}()
}
