package backend

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// BackupProgress represents the progress of a backup operation
type BackupProgress struct {
	TotalFiles       int    `json:"totalFiles"`
	FilesProcessed   int    `json:"filesProcessed"`
	CurrentFile      string `json:"currentFile"`
	BytesTransferred int64  `json:"bytesTransferred"`
	TotalBytes       int64  `json:"totalBytes"`
	Status           string `json:"status"` // e.g., "Scanning", "Hashing", "Storing", "Completed", "Failed"
	Error            string `json:"error"`
}

// ProgressCallback is a function type for reporting backup progress.
type ProgressCallback func(progress BackupProgress)

// RunBackup orchestrates the entire backup process for specified source paths to a CAS base directory.
// It reports progress via the provided ProgressCallback.
func RunBackup(ctx context.Context, casBaseDir string, sourcePaths []string, ignorePatterns []string, progressCallback ProgressCallback) error {
	var currentProgress BackupProgress
	updateProgress := func() {
		if progressCallback != nil {
			progressCallback(currentProgress)
		}
	}

	currentProgress.Status = "Initializing"
	updateProgress()

	// Check for context cancellation early
	select {
	case <-ctx.Done():
		currentProgress.Status = "Cancelled"
		currentProgress.Error = "Backup cancelled during initialization"
		updateProgress()
		return ctx.Err()
	default:
	}

	// 1. Load the latest snapshot
	currentProgress.Status = "Loading previous snapshot..."
	updateProgress()
	latestSnapshot, err := LoadLatestSnapshot(casBaseDir)
	if err != nil {
		// If snapshot loading fails, log warning but continue with no previous snapshot
		fmt.Fprintf(os.Stderr, "Warning: Failed to load latest snapshot, starting fresh backup: %v\n", err)
		latestSnapshot = nil
		currentProgress.Status = "Warning: Could not load previous snapshot, starting fresh"
		updateProgress()
	}

	newSnapshot := &Snapshot{
		Timestamp: time.Now(),
		Source:    sourcePaths,
		Files:     make(map[string]*FileEntry),
	}

	fileCount := 0
	// First pass: count files and estimate total size (optional, for more accurate progress)
	// For simplicity, we'll iterate and count on the fly for now.
	// A more robust solution might do a pre-scan to get TotalFiles and TotalBytes.

	// For each source path, walk through files and process them
	for _, sourcePath := range sourcePaths {
		absSourcePath, err := filepath.Abs(sourcePath)
		if err != nil {
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Failed to get absolute path for source %s: %v", sourcePath, err)
			updateProgress()
			return fmt.Errorf("failed to get absolute path for source %s: %w", sourcePath, err)
		}

		currentProgress.Status = fmt.Sprintf("Scanning %s...", filepath.Base(sourcePath))
		updateProgress()
		
		err = filepath.WalkDir(absSourcePath, func(path string, d fs.DirEntry, err error) error {
			// Check for context cancellation more frequently
			select {
			case <-ctx.Done():
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user"
				updateProgress()
				return ctx.Err() // Propagate cancellation error
			default:
				// Continue
			}
			
			// Prevent UI blocking by yielding control periodically
			if fileCount%100 == 0 {
				// Give other goroutines a chance to run every 100 files
				runtime.Gosched()
			}

			if err != nil {
				// Log error but attempt to continue for other files if possible
				currentProgress.Status = "Scanning (with errors)"
				currentProgress.Error = fmt.Sprintf("Error accessing %s: %v", path, err)
				updateProgress()
				return nil // Don't return error here to allow WalkDir to continue
			}

			// --- IGNORE LOGIC ---
			for _, pattern := range ignorePatterns {
				// Check for absolute path match
				if filepath.IsAbs(pattern) && path == pattern {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil // Skip this file
				}

				// Check for glob pattern match on the name
				match, _ := filepath.Match(pattern, d.Name())
				if match {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil // Skip this file
				}
			}

			// Exclude the backup destination directory itself
			// This check assumes casBaseDir is an absolute path.
			// It's crucial that casBaseDir is passed as an absolute path from the frontend.
			if strings.HasPrefix(path, casBaseDir) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}

			if d.IsDir() {
				return nil // Skip directories after ignore checks
			}

			// Get relative path from the source root
			relPath, err := filepath.Rel(absSourcePath, path)
			if err != nil {
				currentProgress.Status = "Failed"
				currentProgress.Error = fmt.Sprintf("Failed to get relative path for %s: %v", path, err)
				updateProgress()
				return fmt.Errorf("failed to get relative path for %s: %w", path, err)
			}
			// Use forward slashes for consistency regardless of OS
			relPath = filepath.ToSlash(relPath)

			fileInfo, err := d.Info()
			if err != nil {
				currentProgress.Status = "Failed"
				currentProgress.Error = fmt.Sprintf("Failed to get file info for %s: %v", path, err)
				updateProgress()
				return fmt.Errorf("failed to get file info for %s: %w", path, err)
			}

			fileCount++
				currentProgress.TotalFiles = fileCount // Update total files found so far
			currentProgress.FilesProcessed++
			currentProgress.CurrentFile = path
			currentProgress.Status = "Processing file"
			updateProgress()
			
			// Check for context cancellation before heavy file operations
			select {
			case <-ctx.Done():
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user during file processing"
				updateProgress()
				return ctx.Err()
			default:
				// Continue
			}

			currentFileEntry := &FileEntry{
				Path:    relPath,
				Size:    fileInfo.Size(),
				Mode:    fileInfo.Mode(),
				ModTime: fileInfo.ModTime(),
			}

			// Compare with latest snapshot - rsync-like optimization
			var fileHash string
			var fileChanged bool
			
			if latestSnapshot != nil {
				if prevEntry, ok := latestSnapshot.Files[relPath]; ok {
					// Quick check: size and mtime match means file is unchanged
					if prevEntry.Size == currentFileEntry.Size &&
						prevEntry.ModTime.Equal(currentFileEntry.ModTime) {
						fileHash = prevEntry.Hash
					} else {
						fileChanged = true
					}
				} else {
					fileChanged = true // New file
				}
			} else {
				fileChanged = true // First backup
			}

			if fileChanged {
				currentProgress.Status = "↻ " + filepath.Base(path) // Changed file indicator
				updateProgress()
				hash, err := StoreFileContentWithContext(ctx, casBaseDir, path)
				if err != nil {
					if err == context.Canceled {
						currentProgress.Status = "Cancelled"
						currentProgress.Error = "Backup cancelled by user during file processing"
						updateProgress()
						return ctx.Err()
					}
					currentProgress.Status = "✗ Failed"
					currentProgress.Error = fmt.Sprintf("Failed to store content for %s: %v", path, err)
					updateProgress()
					return fmt.Errorf("failed to store content for %s: %w", path, err)
				}
				fileHash = hash
			} else {
				currentProgress.Status = "= " + filepath.Base(path) // Unchanged file indicator
				currentProgress.FilesProcessed-- // Don't count as processed for progress
				updateProgress()
			}
			currentFileEntry.Hash = fileHash
			newSnapshot.Files[relPath] = currentFileEntry
			
			// Only count bytes for files that were actually transferred
			if fileChanged {
				currentProgress.BytesTransferred += fileInfo.Size()
			}
			updateProgress()

			return nil
		})
		if err != nil {
			if err == context.Canceled { // Check if the error was due to context cancellation
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user"
				updateProgress()
				return err // Propagate cancellation error
			}
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Error walking source path %s: %v", sourcePath, err)
			updateProgress()
			return fmt.Errorf("error walking source path %s: %w", sourcePath, err)
		}
	}

	// Calculate sync statistics
	totalFiles := len(newSnapshot.Files)
	changedFiles := 0
	if latestSnapshot != nil {
		for relPath, entry := range newSnapshot.Files {
			if prevEntry, exists := latestSnapshot.Files[relPath]; !exists || prevEntry.Hash != entry.Hash {
				changedFiles++
			}
		}
	} else {
		changedFiles = totalFiles // First backup
	}
	
	currentProgress.Status = fmt.Sprintf("Saving snapshot (%d/%d files changed)", changedFiles, totalFiles)
	updateProgress()

	// 2. Save the new snapshot
	if err := SaveSnapshot(casBaseDir, newSnapshot); err != nil {
		currentProgress.Status = "Failed"
		currentProgress.Error = fmt.Sprintf("Failed to save new snapshot: %v", err)
		updateProgress()
		return fmt.Errorf("failed to save new snapshot: %w", err)
	}

	currentProgress.Status = fmt.Sprintf("✓ Completed: %d files, %d changed, %.2f MB transferred", 
		totalFiles, changedFiles, float64(currentProgress.BytesTransferred)/1024/1024)
	updateProgress()
	return nil
}
