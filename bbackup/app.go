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
